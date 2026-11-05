import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';

// Execute the actual consumer callback: a controller-only test cannot prove
// that a timer-driven budget failure refills the raw mirror.
function callback(source: string, start: string, end: string, names: string[], values: unknown[]) {
  source = source.replace(/\r\n/g, '\n');
  const from = source.indexOf(start);
  if (from < 0) throw new Error('callback start missing');
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error('callback end missing');
  const body = source.slice(from + start.length, to);
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...names, js)(...values);
}
const desktop = readFileSync(fileURLToPath(new URL('../../../renderer/lib/makerChatStore.ts', import.meta.url)), 'utf8');
describe.each(['\n', '\r\n'])('automatic scan budget fallback owners (%j)', (newline) => {
  const desktopSource = desktop.replace(/\r?\n/g, newline);
  it.each([true, false])('Desktop refills only the current active view (active=%s)', async (active) => {
    const reconcile = vi.fn(async () => true);
    const view = { isActive: () => active, getSnapshot: () => ({ ready: false, error: new Error('[UNSUPPORTED_CAPABILITY] History view scan budget exceeded') }) };
    for (const current of [true, false]) {
      reconcile.mockClear();
      callback(desktopSource, '  view.subscribe(() => {', '\n  });\n  void view.restoreCachedView',
        ['isCurrent', 'sessions', 'sessionId', 'view', 'isHistoryViewUnavailable', 'reconcileRemoteMessages', 'persistTimer', 'writeCache', 'setState', 'mirrorScheduled', 'mirrorSnapshot', '_messagesEpoch', 'mirrorEpoch', 'mirrorLease', '_activeViewSessions'],
        [() => current, new Set(['s']), 's', view, isHistoryViewUnavailable, reconcile, undefined, undefined, vi.fn(), false, vi.fn(), new Map(), 0, 0, new Map()]);
      await Promise.resolve();
      expect(reconcile).toHaveBeenCalledTimes(active && current ? 1 : 0);
      if (active && current) expect(reconcile).toHaveBeenCalledWith('s', { force: true });
    }
  });
});
