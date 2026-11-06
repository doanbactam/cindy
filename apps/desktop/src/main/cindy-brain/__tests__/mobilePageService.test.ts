import { describe, expect, it } from 'vitest';
import { MobilePluginPages } from '../mobilePageService.js';
import { GhostModelPicker } from '../ghostModelPicker.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import { toGhostPluginDetail } from '../../../renderer/features/plugin/lib/ghostPluginViewModel.js';
import { parseRemoteResourceGetRequest, type PluginSettingsCommand } from '@cindy/device-link';
function setup(
  projection: Pick<ConstructorParameters<typeof MobilePluginPages>[0], 'answerModelPicker'> = {},
) {
  const ghost = {
    manifest: {
      id: 'practice',
      name: 'Practice',
      version: '1',
      panel: { html: 'panel.html' },
      settingsHtml: 'settings.html',
      // Installed plugins may still declare the retired phone page; it must stay inert.
      mobile: { channels: ['practice-ui'] },
    },
    enabled: true,
    approval: { state: 'approved', revision: 'r1' },
  } as InstalledGhost;
  const service = new MobilePluginPages({
    ...projection,
    captureController: () => () => true,
    list: () => [ghost],
    revision: () => 'r1',
    captureOwner: () => () => true,
    bundle: async () => [{ path: 'settings.html', mime: 'text/html', size: 3 }],
    asset: async () => ({ mime: 'text/html', base64: 'YWJj' }),
    connect: async () => {},
    post: async () => {},
    poll: async () => [],
    disconnect: async () => {},
    settingsFetch: async () => ({ status: 200, mime: 'application/json', base64: '' }),
  });
  const provider = service.provider();
  const invoke = (actionId: string, input: Record<string, unknown> = {}) =>
    provider.invoke!(
      { controllerDeviceId: 'controller-a' },
      {
        collectionId: 'plugins',
        resourceRef: { collectionId: 'plugins', kind: 'plugin', id: 'practice' },
        actionId,
        input,
        client: { protocolVersion: 1, primitives: [] },
      },
    );
  const openSettings = async (input: Record<string, unknown> = {}) =>
    ((await invoke('settings:open', {
      expectedInstalledApproval: ghostInstallApprovalToken(ghost.approval),
      ...input,
    })).result as { pageId: string }).pageId;
  const settings = (id: string, command: PluginSettingsCommand) =>
    service.settingsRequest('controller-a', { op: 'settings', id, command });
  return { service, provider, invoke, openSettings, settings, ghost };
}
describe('remote plugin settings pages', () => {
  // #8460 / unit: old controllers strip agentDeviceId from a remote initial selection.
  // The remote settings page is the remaining page source; page-open → request → poll → answer
  // must reject before delivery when source support is absent, while preserving new controllers'
  // explicit return to this computer.
  it.each([
    { controller: 'legacy', capable: false, remoteInitial: true, localAnswer: true },
    { controller: 'source-aware', capable: true, remoteInitial: true, localAnswer: false },
    { controller: 'source-aware returning home', capable: true, remoteInitial: true, localAnswer: true },
    { controller: 'legacy local request', capable: false, remoteInitial: false, localAnswer: true },
  ])('keeps the execution source safe for $controller', async ({ capable, remoteInitial, localAnswer }) => {
    let picker!: GhostModelPicker;
    const h = setup({ answerModelPicker: (page, id, route) => picker.resolve(page, id, route) });
    const pageId = await h.openSettings(capable ? { modelPickerRemoteSources: true } : {});
    // The same provider/model is available at home: availability alone cannot detect a lost source.
    let checked = false;
    picker = new GhostModelPicker({ getGhost: () => h.ghost, installation: () => 'r1',
      target: (id, page) => page ? h.service.modelPickerTarget(page, id) : null,
      available: async () => { checked = true; return true; } });
    const local = { agentKind: 'codex' as const, providerId: 'same-provider', model: 'same-model', effort: '', fastMode: false };
    const remote = { ...local, agentDeviceId: 'share:fixture' };
    try {
      const selected = picker.request('practice', { mobilePageId: pageId, allowRemote: true,
        initial: remoteInitial ? remote : local });
      const poll = await h.settings(pageId, { kind: 'poll', after: 0 }) as { modelPickers: Array<{ requestId: string }> };
      if (poll.modelPickers.length) {
        await h.settings(pageId, { kind: 'answer-model-picker', requestId: poll.modelPickers[0].requestId,
          route: localAnswer ? local : remote });
      }
      if (remoteInitial && !capable) {
        expect(await selected).toMatchObject({ ok: false, errorCode: 'UNAVAILABLE' });
        expect(poll.modelPickers).toEqual([]);
        expect(checked).toBe(false);
      } else {
        expect(await selected).toEqual({ ok: true, route: localAnswer ? local : remote });
      }
    } finally {
      picker.cancel();
      await h.settings(pageId, { kind: 'close' });
    }
  });
});

it('keeps the longest valid physical identity usable through the wire parser', async () => {
  const fixture = setup();
  fixture.ghost.namespace = 'a'.repeat(128);
  fixture.ghost.manifest.id = 'p'.repeat(32);
  fixture.ghost.dir = '/ghosts/_ns/' + fixture.ghost.namespace + '/' + fixture.ghost.manifest.id;
  const context = { controllerDeviceId: 'controller-a' }, client = { protocolVersion: 1, primitives: [] };
  const list = await fixture.provider.list(context, { collectionId: 'plugins', client });
  const request = parseRemoteResourceGetRequest({ ref: list.items[0].ref, client });
  expect(request).not.toBeNull();
  expect((await fixture.provider.get!(context, request!)).display.title).toBe('Practice');
});

// Phone pages were removed. A plugin that still declares `mobile` must stay listed with the
// enabled state desktop controllers read (§5 compatibility), while the retired phone actions fail.
it('lists a plugin that still declares mobile pages without exposing retired phone actions', async () => {
  const h = setup();
  const list = await h.provider.list(
    { controllerDeviceId: 'controller-a' },
    { collectionId: 'plugins', client: { protocolVersion: 1, primitives: [] } },
  );
  expect(list.items).toHaveLength(1);
  expect(list.items[0].display.status).toMatchObject({ label: 'enabled' });
  expect(list.items[0].actions).toEqual([]);
  for (const actionId of ['open:panel', 'open-interaction', 'readme:get', 'task-settings:get', 'disable']) {
    await expect(h.invoke(actionId)).rejects.toThrow();
  }
  expect(h.ghost.enabled).toBe(true);
});

// The real get projection must retain semantic icon keys alongside localized copy;
// checking both prevents controllers from having to infer permission kinds from text.
it('projects PC permission facts in the controller locale, excludes tools and keeps OAuth scopes', async () => {
  const h = setup();
  h.ghost.manifest.tools = [{name: 'calendar_events', description: 'Read events', parameters: {type: 'object'}}];
  h.ghost.manifest.network = {
    hosts: ['calendar.example'],
    secrets: [{key: 'account', label: 'Calendar account', source: 'oauth', inject: {header: 'Authorization', format: 'Bearer {value}'}, oauth: {
      clientId: 'public-client-id', authorizeUrl: 'https://accounts.example/authorize',
      tokenUrl: 'https://accounts.example/token', scopes: ['calendar.read'],
    }}],
  };
  const detail = await h.provider.get!({controllerDeviceId: 'controller-a'}, {
    ref: {collectionId: 'plugins', kind: 'plugin', id: 'practice'},
    client: {protocolVersion: 1, primitives: ['plugin-capabilities'], locale: 'zh-CN'},
  });
  const facts = detail.blocks?.find(block => block.id === 'capabilities')?.data as {tools: unknown[]; permissions: Array<{kind?: string; labelKey?: string; title: string; description: string}>};
  expect(facts.tools).toEqual([{name: 'calendar_events', description: 'Read events'}]);
  expect(facts.permissions.find(item => item.title.includes('calendar.example'))).toMatchObject({
    kind: 'network', labelKey: 'networkHost',
  });
  expect(facts.permissions.find(item => item.description.includes('calendar.read'))).toMatchObject({
    kind: 'network', labelKey: 'networkSecretOauth',
  });
  expect(JSON.stringify(facts.permissions)).not.toContain('calendar_events');
  expect(JSON.stringify(facts.permissions)).not.toContain('public-client-id');
  expect(JSON.stringify(facts.permissions)).not.toContain('settings.ghosts.perm');
  expect(JSON.stringify(facts.permissions)).not.toContain('{{');
  expect(facts.permissions.some(item => /[\u4e00-\u9fff]/.test(item.title))).toBe(true);
});


it('projects the same installed Details as PC, with factual unsigned trust and no invented panel status', async () => {
  const h = setup();
  h.ghost.manifest.author = 'Cindy';
  h.ghost.manifest.version = '1.3.13';
  h.ghost.manifest.settingsHtml = 'settings.html';
  h.ghost.dir = '/plugin-install/practice';
  delete h.ghost.manifest.panel;
  const read = async () => {
    const detail = await h.provider.get!({controllerDeviceId: 'controller-a'}, {
      ref: {collectionId: 'plugins', kind: 'plugin', id: 'practice'},
      client: {protocolVersion: 1, primitives: ['plugin-capabilities'], locale: 'en'},
    });
    return (detail.blocks?.find(block => block.id === 'capabilities')?.data as {details: Array<{key: string; title: string; value: string}>}).details;
  };
  const pc = toGhostPluginDetail(h.ghost);
  const facts = await read();
  const values = Object.fromEntries(facts.map(fact => [fact.key, fact.value]));
  expect(values).toMatchObject({version: 'v' + pc.version, author: pc.author, identifier: pc.id, location: pc.installDir, trust: 'Unverified / unsigned', panel: 'This plugin has no panel'});
  expect(facts.map(fact => fact.title)).toEqual(['Version', 'Author', 'Source & signature', 'Identifier', 'Contains', 'Panel', 'Install location']);
  expect(values.contents).toBe('Custom settings UI · Executable code');
  h.ghost.trust = {level: 'unverified', publisherSigned: true, publisherVerified: false, reviewed: false, publisherName: 'Independent publisher', publisherKeyId: 'not-a-display-field'};
  const signed = await read();
  expect(signed.find(fact => fact.key === 'trust')?.value).toBe('Signed, but publisher identity is unverified: Independent publisher');
  expect(JSON.stringify(signed)).not.toContain('not-a-display-field');
  h.ghost.manifest.panel = {html: 'panel.html', position: 'tab'};
  expect((await read()).find(fact => fact.key === 'panel')?.value).toBe('Panel');
  h.ghost.publishingSource = { kind: 'public-market', pluginId: 'public-practice' };
  expect(toGhostPluginDetail(h.ghost).author).toBeNull();
  expect((await read()).some(fact => fact.key === 'author')).toBe(false);
  h.ghost.publishingSource = { kind: 'local', source: 'manual' };
  expect((await read()).find(fact => fact.key === 'author')?.value).toBe('Cindy');
});
