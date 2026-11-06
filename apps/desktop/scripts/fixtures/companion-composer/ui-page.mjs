import assert from 'node:assert/strict';

export default {
  name: 'companion-composer',
  entry: './companion-composer-fixture.tsx',
  viewport: { width: 760, height: 360 },
  real: 'ChatInput, Tiptap editor, useAttachments, SendButton, tooltips, send dispatch, themes and translations',
  notCovered:
    'Live companion tasks and real media IO; host services, delayed image cache and model catalog use scenario data. Windows runtime is not exercised.',
  stubs: {
    'src/renderer/hooks/useProviders': `const providers = [{ id: 'openai', name: 'OpenAI', source: 'builtin', connected: true, agents: ['codex'], auth: { method: 'oauth' }, routing: { codex: { upstream: 'https://example.test', authStrategy: 'oauth-passthrough' } }, models: { codex: [{ id: 'fixture-chat', name: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] } }]; export const useProviders = () => ({ providers, loading: false });`,
    'src/renderer/hooks/useDeviceProviders': {
      partial: `export const useDeviceProviders = () => ({ providers: [], loading: false, unsupported: false });`,
    },
    'src/renderer/hooks/useConnectedSource': `export const useConnectedSource = () => ({ hasConnectedSource: true, loading: false });`,
    'src/renderer/hooks/useAvailableAgents': {
      partial: `export const useAvailableAgents = () => ({ agents: [], loading: false });`,
    },
    'src/renderer/hooks/useAgentCapabilities': {
      partial: `export const useAgentCapabilities = () => ({ capabilities: null, loading: false });`,
    },
    'src/renderer/components/new-chat/ExtraDirsButton': `export const ExtraDirsButton = () => null;`,
    'src/renderer/components/new-chat/PermissionSelector': `export const PermissionSelector = () => null;`,
    'src/renderer/components/new-chat/NewGoalDialog': `export const NewGoalDialog = () => null;`,
    'src/renderer/components/new-chat/AtMentionPanel': `export const AtMentionPanel = () => null;`,
    'src/renderer/components/new-chat/SlashCommandPalette': `export const SlashCommandPalette = () => null;`,
  },
  cases: {
    'late-attachment': {
      about: 'A cache result from the unmounted composer restores its image without replacing fresh text inside the 120ms save window',
    },
    default: {
      about:
        'Empty/text/attachment send state, stable target, keyboard send and stop/queue',
    },
    narrow: {
      about: 'Same companion interactions at narrow width',
      viewport: { width: 360, height: 400 },
    },
  },
  async ready(page) {
    await page.locator('[contenteditable="true"]').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'late-attachment') {
      await page.locator('input[type="file"]').setInputFiles({
        name: 'late.png', mimeType: 'image/png', buffer: Buffer.from('fixture-image-bytes'),
      });
      await page.waitForFunction(() => typeof window.__composerImageCache.finish === 'function');
      const toggle = page.getByTestId('toggle-composer');
      await toggle.click();
      await page.locator('.ProseMirror').waitFor({ state: 'detached' });
      await toggle.click();
      const editor = page.locator('.ProseMirror');
      await editor.waitFor();
      // One renderer turn pins the cache completion inside the real debounce window.
      const savedBefore = await page.evaluate(() => {
        document.querySelector('.ProseMirror').editor.commands.insertContent('Keep unsaved text');
        const saved = window.__composerImageCache.getDraft()?.text;
        window.__composerImageCache.finish();
        return saved;
      });
      assert.ok(!JSON.stringify(savedBefore).includes('Keep unsaved text'));
      await page.locator('img[alt="late.png"]').waitFor();
      assert.equal(await editor.textContent(), 'Keep unsaved text');
      await ui.capture('late-image-preserves-text');
      await page.waitForFunction(() => JSON.stringify(window.__composerImageCache.getDraft()?.text).includes('Keep unsaved text'));
      return;
    }
    const editor = page.locator('[contenteditable]');
    const send = page.getByRole('button', {
      name: await ui.t('newChat.sendButton.send'),
      exact: true,
    });
    assert.equal(await send.isDisabled(), true);
    const slotBefore = await send.boundingBox();
    await editor.fill('   ');
    assert.equal(await send.isDisabled(), true);
    await editor.fill('Hello Cindy');
    assert.equal(await send.isEnabled(), true);
    assert.deepEqual(await send.boundingBox(), slotBefore);
    await ui.capture('typed');
    await send.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sent"]')?.textContent === 'Hello Cindy');
    assert.equal(await send.isDisabled(), true);
    await page.getByTestId('attachment').click();
    await page.waitForFunction((node) => !node.disabled, await send.elementHandle());
    assert.equal(await send.isEnabled(), true);
    await ui.capture('attachment');
    await page.getByTestId('attachment').click();
    await editor.fill('Keyboard message');
    await editor.press('Shift+Enter');
    assert.equal(await page.getByTestId('sent').textContent(), 'Hello Cindy');
    await editor.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="sent"]')?.textContent.trim() === 'Keyboard message');
    await page.getByTestId('running').click();
    const stop = page.getByRole('button', {
      name: await ui.t('newChat.sendButton.stop'),
      exact: true,
    });
    await stop.waitFor();
    await editor.fill('Next message');
    await page
      .getByRole('button', { name: await ui.t('newChat.sendButton.queue'), exact: true })
      .waitFor();
    assert.equal(await stop.count(), 1);
    await ui.capture('queue');
    await stop.click();
  },
};
