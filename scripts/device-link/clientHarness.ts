import WebSocket from "ws";
import {
  DeviceLinkClient,
  DeviceLinkError,
  PROTOCOL_VERSION,
  type DeviceLinkFrameAuth,
  type DeviceLinkTiming,
  type Envelope,
  type InvokePayload,
  type LinkOpenPayload,
} from "../../packages/device-link/src/index";
import {
  createSubscriptionReplayScheduler,
  isPermanentSubscriptionReplayError,
} from "../../apps/desktop/src/main/device-link/subscriptionReplayScheduler";
import { requiresSessionLink } from "../../apps/desktop/src/main/device-link/linkRecovery";

export const SESSION_ID = "fixture-session";
export const TOPICS = [`session:${SESSION_ID}`, "sessions"] as const;

export function createClient(
  url: string,
  id: string,
  host = false,
  options: {
    token?: string;
    authorizationScheme?: "Bearer" | "CindyRelay";
    timing?: Partial<DeviceLinkTiming>;
    /** 自建中转的设备签名钩子(与 Desktop 传给 DeviceLinkClient 的同一选项)。 */
    frameAuth?: () => DeviceLinkFrameAuth | null;
  } = {},
) {
  const sockets: WebSocket[] = [];
  const socketCreatedAt: number[] = [];
  const statuses: string[] = [];
  const client = new DeviceLinkClient({
    getWsUrl: () => url,
    getToken: async () => options.token ?? `fixture-${id}`,
    authorizationScheme: options.authorizationScheme,
    frameAuth: options.frameAuth,
    getHello: () => ({
      deviceName: `Integration ${id}`,
      platform: "darwin",
      appVersion: "0.0.0-test",
      remoteControlEnabled: host,
      busy: false,
    }),
    createWebSocket: (address, headers) => {
      const ws = new WebSocket(address, { headers });
      sockets.push(ws);
      socketCreatedAt.push(performance.now());
      return ws;
    },
    // Bounded real-time waits, never fake socket/timer events. Interop overrides these.
    timing: {
      reconnectBaseMs: 30,
      reconnectMaxMs: 100,
      requestTimeoutMs: 2_000,
      pingIntervalMs: 1_000,
      pongMissLimit: 3,
      transportRetryIntervalMs: 100,
      transportMaxRetryAttempts: 5,
      congestionBackoffBaseMs: 300,
      congestionBackoffMaxMs: 600,
      ...options.timing,
    },
    // No raw relay errors or tokens in test output; assertions report stages instead.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client.onStatusChange((status) => statuses.push(status));
  return {
    client,
    sockets,
    socketCreatedAt,
    statuses,
    close() {
      client.stop();
      for (const ws of sockets) ws.terminate();
    },
  };
}

export async function invoke(
  client: DeviceLinkClient,
  hostId: string,
  channel: string,
  args: unknown[] = [],
) {
  const reply = await client.invoke(hostId, { channel, args });
  if (!reply.ok)
    throw new DeviceLinkError("INTERNAL", "fixture invoke rejected");
  return reply.result;
}

/** Host data/IPC fixture. Transport, reliable ordering and request matching are production code. */
export function createHost(client: DeviceLinkClient) {
  const messages = [{ id: "m1", clientId: "m1", content: "initial" }];
  const subscriptions = new Map<string, string[]>();
  const executions = new Map<string, number>();
  const received: Envelope[] = [];
  let paused = false;
  let failNextSubscribe = false;
  let heldResult: (() => void) | undefined;
  const off = client.onFrame((env) => {
    received.push(env);
    if (!env.src || !env.id) return;
    if (env.kind === "link-open") {
      client.sendLinkAccept(env.src, env.id, {
        appVersion: "0.0.0-test",
        allowlistHash: "fixture",
      });
      return;
    }
    if (env.kind !== "invoke") return;
    const { channel, args } = env.payload as InvokePayload;
    executions.set(env.id, (executions.get(env.id) ?? 0) + 1);
    let result: unknown;
    switch (channel) {
      case "device-link:subscribe":
        if (failNextSubscribe) {
          failNextSubscribe = false;
          client.sendInvokeResult(env.src, env.id, {
            ok: false,
            error: {
              code: "INVOKE_TIMEOUT",
              message: "injected transient subscribe failure",
            },
          });
          return;
        }
        subscriptions.set(env.src, (args[0] as { topics: string[] }).topics);
        result = { ok: true };
        break;
      case "device-link:unsubscribe":
        subscriptions.delete(env.src);
        result = { ok: true };
        break;
      case "local-db:messages:list":
        result = [...messages];
        break;
      case "maker:input:get":
        result = { sessionId: SESSION_ID, queuePaused: paused };
        break;
      case "local-db:sessions:list":
        result = [{ id: SESSION_ID, title: "Fixture" }];
        break;
      case "fixture:held": {
        const { src, id } = env;
        heldResult = () =>
          client.sendInvokeResult(src!, id!, { ok: true, result: "released" });
        return;
      }
      default:
        client.sendInvokeResult(env.src, env.id, {
          ok: false,
          error: { code: "CHANNEL_NOT_ALLOWED", message: "fixture channel" },
        });
        return;
    }
    client.sendInvokeResult(env.src, env.id, { ok: true, result });
  });
  return {
    messages,
    subscriptions,
    executions,
    received,
    addMessage(id: string) {
      messages.push({ id, clientId: id, content: id });
    },
    setPaused(value: boolean) {
      paused = value;
    },
    failSubscriptionOnce() {
      failNextSubscribe = true;
    },
    get hasHeldResult() {
      return Boolean(heldResult);
    },
    releaseResult() {
      heldResult?.();
      heldResult = undefined;
    },
    close: off,
  };
}

/**
 * Desktop controller recovery, wired the way `apps/desktop/src/main/device-link/index.ts` wires it:
 * relay `online` replays every subscription, a presence flip to available replays that peer and an
 * offline peer cancels its replay. Scheduling, gating and retry are the production
 * `createSubscriptionReplayScheduler`; the link-reopen rule is production `requiresSessionLink`.
 * The adapter below stands in for `remoteSubscribe` plus the renderer's snapshot re-read; it does
 * not boot Electron, SQLite or the renderer.
 */
export function createControllerRecovery(client: DeviceLinkClient, hostId: string) {
  const state = {
    messages: [] as { id: string }[],
    queuePaused: false,
    completed: 0,
  };
  const available = new Map<string, boolean>();
  let active = true;
  const scheduler = createSubscriptionReplayScheduler({
    snapshotSubscriptions: (deviceId) =>
      !deviceId || deviceId === hostId
        ? [{ deviceId: hostId, topics: [...TOPICS] }]
        : [],
    remoteSubscribe: async (deviceId, topics) => {
      if (
        client.needsLinkRecovery(deviceId) ||
        (requiresSessionLink(topics) && !client.isLinkReady(deviceId))
      ) {
        await client.openLink(deviceId, {
          controllerName: "Integration controller",
          protocolVersion: PROTOCOL_VERSION,
          appVersion: "0.0.0-test",
        } satisfies LinkOpenPayload);
      }
      const reply = await client.invoke(deviceId, {
        channel: "device-link:subscribe",
        args: [{ topics }],
      });
      if (!reply.ok)
        throw new DeviceLinkError("INVOKE_TIMEOUT", "fixture subscribe failed");
      const [messages, projection] = await Promise.all([
        invoke(client, deviceId, "local-db:messages:list", [SESSION_ID]),
        invoke(client, deviceId, "maker:input:get", [SESSION_ID]),
      ]);
      if (!active) return;
      state.messages = messages as { id: string }[];
      state.queuePaused = (projection as { queuePaused: boolean }).queuePaused;
      state.completed++;
    },
    isLinkTornDown: () => !active,
    isRelayOnline: () => client.getStatus() === "online",
    isDeviceUnresponsive: () => false,
    getPresenceAvailability: (deviceId) => available.get(deviceId),
    isPermanentError: (error, deviceId) =>
      isPermanentSubscriptionReplayError(error, available.get(deviceId)),
    log: { debug() {}, warn() {} },
    retryBaseMs: 50,
    retryMaxMs: 200,
  });
  const off = client.onStatusChange((status) => {
    if (status === "online") scheduler.replay("ws-online");
    else available.clear();
  });
  const offPresence = client.onPresenceChanged((presence) => {
    const wasAvailable = available.get(presence.deviceId);
    const isAvailable = presence.online && presence.remoteControlEnabled;
    available.set(presence.deviceId, isAvailable);
    if (!isAvailable) scheduler.cancel(presence.deviceId);
    else if (wasAvailable !== true)
      scheduler.replay("presence-online", presence.deviceId);
  });
  return {
    state,
    /** For a client that was already online before recovery was attached. */
    replay() {
      scheduler.replay("attach");
    },
    close() {
      active = false;
      off();
      offPresence();
      scheduler.teardown();
    },
  };
}
