import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRelayFixture } from "./relayFixture";
import {
  createClient,
  createHost,
  createControllerRecovery,
  invoke,
  SESSION_ID,
  TOPICS,
} from "./clientHarness";
import { DEVICE_LINK_TRANSPORT_ACK_CHANNEL } from "../../packages/device-link/src/transport";
import {
  DeviceLinkError,
  PROTOCOL_VERSION,
} from "../../packages/device-link/src/protocol";
import { createSubscriptionReplayScheduler } from "../../apps/desktop/src/main/device-link/subscriptionReplayScheduler";
import { encodeMessageBodies, versionMessageBody } from '../../apps/desktop/src/main/device-link/sessionMessageReuse';
import { CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1, type InvokePayload } from '../../packages/device-link/src/index';

const until = (check: () => void) =>
  vi.waitFor(check, { timeout: 8_000, interval: 10 });
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const relay = await createRelayFixture();
  cleanups.push(() => relay.close());
  const host = createClient(relay.url, "host", true);
  const controller = createClient(relay.url, "controller");
  cleanups.push(
    () => host.close(),
    () => controller.close(),
  );
  const data = createHost(host.client);
  const recovery = createControllerRecovery(controller.client, "host");
  cleanups.push(data.close, recovery.close);
  host.client.start();
  await until(() => expect(host.client.getStatus()).toBe("online"));
  controller.client.start();
  await until(() =>
    expect(
      recovery.state.completed,
      JSON.stringify({
        statuses: controller.statuses,
        frames: relay.frames.map((frame) => [frame.src, frame.kind, frame.dst]),
      }),
    ).toBeGreaterThan(0),
  );
  await until(() => {
    expect(host.client.getReliableSendQueueDepth("controller")).toBe(0);
    expect(controller.client.getReliableSendQueueDepth("host")).toBe(0);
  });
  return { relay, host, controller, data, recovery };
}

describe("Device Link over real loopback WebSockets (contract fixture)", () => {
  it('reuses a full long list message over real sockets on a desktop controller', async () => {
    const relay = await createRelayFixture();
    cleanups.push(() => relay.close());
    const host = createClient(relay.url, 'host', true);
    const desktop = createClient(relay.url, 'desktop');
    cleanups.push(() => host.close(), () => desktop.close());
    const text = '提前传输的完整聊天内容，打开时直接复用。'.repeat(2000);
    const row = { id: 'm1', clientId: 'm1', sessionId: SESSION_ID, role: 'assistant', content: text,
      createdAt: '2026-10-10T00:00:00.000Z' };
    const page = { version: 1, items: [{ type: 'messages', key: 'm1', messages: [row] }], hasMore: false, nextCursor: null };
    const wireResults: unknown[] = [];
    let pushed = false;
    let subscribed: string[] | undefined;
    host.client.onFrame(env => {
      if (!env.src || !env.id) return;
      if (env.kind === 'link-open') {
        host.client.sendLinkAccept(env.src, env.id, { appVersion: 'test', allowlistHash: 'fixture' });
      } else if (env.kind === 'invoke') {
        const request = env.payload as InvokePayload;
        if (request.channel === 'device-link:subscribe') {
          subscribed = (request.args[0] as { topics: string[] }).topics;
          host.client.sendInvokeResult(env.src, env.id, { ok: true, result: {} });
        } else {
          const result = encodeMessageBodies(request.channel, request.args, page);
          wireResults.push(result);
          host.client.sendInvokeResult(env.src, env.id, { ok: true, result });
        }
      }
    });
    host.client.start(); desktop.client.start();
    await until(() => [host, desktop].forEach(peer => expect(peer.client.getStatus()).toBe('online')));
    desktop.client.onFrame(env => { if (env.kind === 'push') pushed = true; });
    await desktop.client.openLink('host', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION,
      appVersion: 'test', capabilities: [CONTROLLER_CAPABILITY_SESSION_LIST_MESSAGES_V1] });
    await invoke(desktop.client, 'host', 'device-link:subscribe', [{ topics: ['sessions'] }]);
    host.client.sendPush('desktop', 'local-db:messages:created', { sessionId: SESSION_ID, listMessage: true, message: versionMessageBody(row) });
    await until(() => expect(pushed).toBe(true));
    const result = await invoke(desktop.client, 'host', 'local-db:messages:view', [SESSION_ID, { lazyDetails: true }]);
    expect(result).toMatchObject(page);
    expect(subscribed).toEqual(['sessions']);
    expect(wireResults).toHaveLength(1);
    expect(JSON.stringify(wireResults[0])).not.toContain(text);
    expect(Buffer.byteLength(JSON.stringify(wireResults[0]))).toBeLessThan(600);
    process.stdout.write(`Message reuse wire evidence: full=${Buffer.byteLength(JSON.stringify(page))} bytes, desktop=${Buffer.byteLength(JSON.stringify(wireResults[0]))} bytes; decoded text exact\n`);
  });

  it("runs the explicit external-relay entry against a provisioned fixture without silently falling back", async () => {
    const relay = await createRelayFixture();
    cleanups.push(() => relay.close());
    const result = await promisify(execFile)(
      process.execPath,
      ["scripts/device-link/run.mjs", "--interop"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        timeout: 45_000,
        env: {
          ...process.env,
          CINDY_TEST_RELAY_URL: relay.url,
          CINDY_TEST_HOST_TOKEN: "fixture-external-host",
          CINDY_TEST_CONTROLLER_TOKEN: "fixture-external-controller",
        },
      },
    );
    expect(relay.connections.get("external-host")).toBe(1);
    expect(relay.connections.get("external-controller")).toBeGreaterThan(1);
    expect(result.stdout + result.stderr).not.toContain("fixture-external-");
    expect(result.stdout + result.stderr).not.toContain(relay.url);
  }, 50_000);

  it("automatically reconnects the SAME controller client and rehydrates missed data and subscriptions", async () => {
    const { relay, controller, data, recovery } = await setup();
    expect(recovery.state.messages.map((message) => message.id)).toEqual([
      "m1",
    ]);
    const completed = recovery.state.completed;
    // No manual connectDevice/openLink/subscribe after this fault: status callbacks drive recovery.
    data.addMessage("m2");
    data.setPaused(true);
    data.subscriptions.delete("controller");
    relay.disconnect("controller");
    await until(() =>
      expect(recovery.state.completed).toBeGreaterThan(completed),
    );
    expect(controller.sockets.length).toBeGreaterThan(1);
    expect(data.subscriptions.get("controller")).toEqual([...TOPICS]);
    expect(recovery.state.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(recovery.state.queuePaused).toBe(true);
  });

  it("detects a half-open path via heartbeat and automatically recovers once traffic returns", async () => {
    const { relay, controller, data, recovery } = await setup();
    const completed = recovery.state.completed;
    relay.dropFrames((frame) => frame.src === "controller");
    data.addMessage("during-blackhole");
    await until(() =>
      expect(
        controller.statuses.filter((status) => status === "connecting").length,
      ).toBeGreaterThan(1),
    );
    relay.dropFrames(() => false);
    await until(() =>
      expect(recovery.state.completed).toBeGreaterThan(completed),
    );
    expect(recovery.state.messages.map((message) => message.id)).toContain(
      "during-blackhole",
    );
  });

  it("keeps another controller and its in-flight request alive when one peer stops ACKing", async () => {
    const { relay, host, data } = await setup();
    const healthy = createClient(relay.url, "desktop");
    cleanups.push(() => healthy.close());
    healthy.client.start();
    await until(() => expect(healthy.client.getStatus()).toBe("online"));
    await healthy.client.openLink("host", {
      controllerName: "Desktop controller",
      protocolVersion: PROTOCOL_VERSION,
      appVersion: "0.0.0-test",
    });
    const held = invoke(healthy.client, "host", "fixture:held").then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await until(() => expect(data.hasHeldResult).toBe(true));
    relay.dropFrames(
      (frame) =>
        frame.src === "controller" &&
        frame.kind === "push" &&
        (frame.payload as { channel?: string })?.channel ===
          DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
    );
    host.client.sendPush("controller", "maker:event", {
      sessionId: SESSION_ID,
      text: "unacknowledged",
    });
    await until(() =>
      expect(
        relay.frames.some(
          (frame) =>
            frame.kind === "link-close" &&
            frame.dst === "controller" &&
            (frame.payload as { reason?: string })?.reason ===
              "transport-timeout",
        ),
      ).toBe(true),
    );
    data.releaseResult();
    expect(await held).toEqual({ result: "released" });
    expect(
      await invoke(healthy.client, "host", "local-db:messages:list", [
        SESSION_ID,
      ]),
    ).toHaveLength(1);
    expect(relay.connections.get("host")).toBe(1);
    expect(relay.connections.get("desktop")).toBe(1);
    expect(healthy.statuses.filter((status) => status !== "online")).toEqual([
      "connecting",
    ]);
  });

  it("replays a lost result without executing the request twice", async () => {
    const { relay, controller, data } = await setup();
    let dropped = false;
    relay.dropFrames((frame) => {
      if (frame.kind !== "invoke-result" || frame.dst !== "controller" || dropped)
        return false;
      dropped = true;
      return true;
    });
    const previous = new Set(data.executions.keys());
    expect(
      await invoke(controller.client, "host", "local-db:messages:list", [
        SESSION_ID,
      ]),
    ).toHaveLength(1);
    expect(dropped).toBe(true);
    const executions = [...data.executions].filter(([id]) => !previous.has(id));
    expect(executions).toHaveLength(1);
    expect(executions[0][1]).toBe(1);
  });

  it("rebuilds link and snapshot when the host client restarts with a new reliable stream", async () => {
    const { relay, host, data, recovery, controller } = await setup();
    const completed = recovery.state.completed;
    let hostOffline = false;
    const off = controller.client.onPresenceChanged((presence) => {
      if (presence.deviceId === "host" && !presence.online) hostOffline = true;
    });
    cleanups.push(off);
    data.close();
    host.close();
    await until(() => expect(hostOffline).toBe(true));
    const replacement = createClient(relay.url, "host", true);
    const replacementData = createHost(replacement.client);
    replacementData.addMessage("after-host-restart");
    cleanups.push(() => replacement.close(), replacementData.close);
    replacement.client.start();
    await until(() =>
      expect(recovery.state.messages.map((message) => message.id)).toEqual([
        "m1",
        "after-host-restart",
      ]),
    );
    expect(recovery.state.completed).toBeGreaterThan(completed);
    expect(replacementData.subscriptions.get("controller")).toEqual([...TOPICS]);
    // No socket-count assertion: Desktop keeps the default peerFailurePolicy, so a reliable frame
    // stranded on the old host stream may legitimately escalate to one relay reconnect.
  });

  it("honors relay 1013 cooldown before recovering instead of immediately reopening", async () => {
    const { relay, controller, recovery } = await setup();
    const completed = recovery.state.completed;
    const closedAt = performance.now();
    relay.disconnect("controller", 1013);
    await until(() => expect(controller.client.getStatus()).toBe("connecting"));
    controller.client.connectNow("test-foreground");
    await until(() =>
      expect(recovery.state.completed).toBeGreaterThan(completed),
    );
    // Production jitter has a 0.7 floor; injected congestion base is 300ms.
    expect(controller.socketCreatedAt[1] - closedAt).toBeGreaterThanOrEqual(
      200,
    );
    expect(relay.connections.get("controller")).toBe(2);
  });

  it("retries Desktop subscription replay over the wire after a transient subscribe failure", async () => {
    const { relay, data } = await setup();
    const desktop = createClient(relay.url, "desktop");
    cleanups.push(() => desktop.close());
    let calls = 0;
    const scheduler = createSubscriptionReplayScheduler({
      snapshotSubscriptions: () => [{ deviceId: "host", topics: [...TOPICS] }],
      remoteSubscribe: async (id, topics) => {
        calls++;
        const reply = await desktop.client.invoke(id, {
          channel: "device-link:subscribe",
          args: [{ topics }],
        });
        if (!reply.ok)
          throw new DeviceLinkError("INVOKE_TIMEOUT", "injected failure");
      },
      isLinkTornDown: () => false,
      isRelayOnline: () => desktop.client.getStatus() === "online",
      isDeviceUnresponsive: () => false,
      getPresenceAvailability: () => true,
      isPermanentError: () => false,
      log: { debug() {}, warn() {} },
      retryBaseMs: 30,
      retryMaxMs: 100,
    });
    const off = desktop.client.onStatusChange((status) => {
      if (status === "online") scheduler.replay("ws-online");
    });
    cleanups.push(off, () => scheduler.teardown());
    data.failSubscriptionOnce();
    desktop.client.start();
    await until(() =>
      expect(data.subscriptions.get("desktop")).toEqual([...TOPICS]),
    );
    expect(calls).toBe(2);
  });
});
