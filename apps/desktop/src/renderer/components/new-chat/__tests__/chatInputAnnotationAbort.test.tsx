// @vitest-environment jsdom
/**
 * ChatInput × 标注烧录中止:已有任务的发送会请求 annotationBurnFailure: 'abort';
 * 发送被中止(onSend 返回 false,makerChatStore 烧录失败时即如此)后,点击时的正文、
 * 附件与矢量笔迹原样回到输入框,用户可直接重试。脚手架与 chatInputModelLoading
 * 相同:外部宿主服务全部惰性,编辑器、输入框状态与发送派发真实运行。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProviderView } from '@cindy/model-providers';
import { sshNativeCodexProvider, sshModel, sshProvider } from '@/features/cc-agent/__tests__/sshModelFixtures';
import type { AttachedFile } from '@/lib/fileTypes';
import { ChatInput } from '../ChatInput';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import type { AtMentionPanel } from '../AtMentionPanel';
import type { scanAtResources } from '@/lib/atResourceService';
import type { ExtraDirsButton } from '../ExtraDirsButton';
import type { PermissionSelector } from '../PermissionSelector';
import type { ModelSelector } from '../ModelSelector';
import { useAttachments } from '@/hooks/useAttachments';
import { dispatchInputDeviceAction } from '@/lib/inputDeviceActions';
import type { InputDeviceRendererAction } from '../../../../shared/inputDevices';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(),
  // Tiptap exposes the live editor on its root node; the composer mounts one at a time.
  get editor(): Editor | null {
    return (document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null)?.editor ?? null;
  },
  setModel: vi.fn(), selectModel: undefined as ComponentProps<typeof ModelSelector>['onModelChange'] | undefined, remoteProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
  scan: vi.fn<typeof scanAtResources>(),
  atPanel: null as ComponentProps<typeof AtMentionPanel> | null,
  realModelSelector: false,
  listAgentSkills: vi.fn(),
  localProviders: [] as ProviderView[],
  uploadChatFolder: vi.fn(),
  cacheImageFromBuffer: vi.fn(),
  atPanelStandin: false,
}));

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', async (original) => ({ ...await original<typeof import('@/components/ui/confirm-dialog-provider')>(), useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({
    items,
    renderItem,
    role,
    ariaLabel,
    className,
  }: {
    items: readonly unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
    role?: string;
    ariaLabel?: string;
    className?: string;
  }) => (
    <div role={role} aria-label={ariaLabel} className={className}>
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));
vi.mock('../ModelSelector', async (original) => {
  const real = await original<typeof import('../ModelSelector')>();
  return { ...real, ModelSelector: (props: ComponentProps<typeof ModelSelector>) => {
    h.selectModel = props.onModelChange;
    return h.realModelSelector ? <real.ModelSelector {...props} /> : <span data-testid="model-selector">{props.modelId}</span>;
  } };
});
vi.mock('@/hooks/useSshCodexProviders', () => ({ useSshCodexProviders: () => ({ providers: h.remoteProviders, status: h.remoteStatus, refresh: () => {} }) }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: ({ open, onOpenChange, panel, disabled }: ComponentProps<typeof ExtraDirsButton>) => <><button aria-label="test-suggestions" disabled={disabled} onClick={() => onOpenChange?.(!open)} />{open && panel}</> }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: ({ disabled }: ComponentProps<typeof PermissionSelector>) => <button data-testid="permission-selector" disabled={disabled} /> }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('../AtMentionPanel', () => ({ AtMentionPanel: (props: ComponentProps<typeof AtMentionPanel>) => {
  h.atPanel = props;
  // 焦点归还需要真实 DOM:焦点测试用与真实面板同契约的最小替身(面板根标记 + 搜索框)。
  return h.atPanelStandin ? (
    <div data-composer-suggestion-panel="">
      <input data-composer-suggestion-search="" aria-label="newChat.atMention.typeToSearchFiles" />
    </div>
  ) : null;
} }));
vi.mock('@/lib/atResourceService', async (original) => ({ ...await original<typeof import('@/lib/atResourceService')>(), scanAtResources: h.scan }));
vi.mock('../SlashCommandPalette', () => ({ SlashCommandPalette: ({ query, commands }: { query: string; commands: { name: string }[] }) =>
  <div data-testid="test-slash-palette" data-query={query} data-commands={commands.map(command => command.name).join(',')} /> }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: h.localProviders, providerOrder: [], loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

const noOp = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = new Proxy({}, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'uploadChatFolder') return h.uploadChatFolder;
  if (key === 'cacheImageFromBuffer') return h.cacheImageFromBuffer;
  if (key === 'getFilePath') return () => '/controller/docs';
  if (key === 'listAgentSkills') return h.listAgentSkills;
  if (key === 'listAgentCommands' || key === 'listDesktopCommands') return async () => ({ success: true, commands: [] });
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'platform') return 'darwin';
  if (key === 'modelAccess') return undefined;
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => api[nested] });
} });

const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];
const annotatedImage: AttachedFile = {
  id: 'tray-annotated',
  name: 'shot.png',
  path: '/Users/sam/shot.png',
  ext: '.png',
  size: 10,
  category: 'image',
  mimeType: 'image/png',
  url: 'cindy-media://blobs/tray.png',
  annotationStrokes: strokes,
};

beforeEach(() => {
  h.uploadChatFolder.mockReset();
  h.cacheImageFromBuffer.mockReset().mockResolvedValue(undefined);
  h.listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [] });
  h.localProviders = [];
  h.realModelSelector = false;
  h.atPanel = null;
  h.scan.mockReset().mockResolvedValue({ success: true, items: [], truncated: false });
  window.electronAPI = api;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearDraft('composer-regression'); h.remoteProviders = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderComposer(extra: Partial<ComponentProps<typeof ChatInput>> = {}) {
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: files => [...files],
  };
  const props = { draftKey: 'composer-regression', deviceLinkDeviceId: null,
    attachmentState,
    hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
    onSend: vi.fn().mockResolvedValue(true), ...extra };
  const view = render(<ChatInput {...props} />);
  return { ...view, props };
}

function supplyRangeGeometry() {
  // jsdom has no layout. Keep real ranges/selections while ProseMirror focuses.
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    const rect = new DOMRect();
    range.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
    range.getBoundingClientRect = () => rect;
    return range;
  });
}

// Replaces the source-only guards with real editor transactions at the two
// external-draft boundaries. Empty paragraph JSON is the minimal #720 input;
// a document replacement would move the caret.
it('does not replace the empty editor after an external empty-draft notification', async () => {
  renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const changed = vi.fn();
  h.editor!.on('transaction', ({ transaction }) => { if (transaction.docChanged) changed(); });
  await act(async () => saveDraft('composer-regression', {
    text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [],
  }));
  expect(changed).not.toHaveBeenCalled();
  expect(h.editor!.state.selection.from).toBe(1);
});

// #8084 / r4428883080: thread textarea coverage missed ChatInput's debounced text save.
// Unit: real ChatInput/Tiptap + attachment hook, one pending image across a remount;
// its late result must appear in the tray without replacing unsaved editor text.
it('keeps unsaved editor text when an unmounted composer finishes caching an image', async () => {
  let finishCache!: (value: { url: string }) => void;
  const cached = new Promise<{ url: string }>(resolve => { finishCache = resolve; });
  h.cacheImageFromBuffer.mockReturnValue(cached);
  let addImage!: ReturnType<typeof useAttachments>['addClipboardImage'];
  function Composer() {
    const attachmentState = useAttachments('composer-regression');
    addImage = attachmentState.addClipboardImage;
    return <ChatInput sessionId="composer-regression" deviceLinkDeviceId={null}
      attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
      disableAutofocus onSend={async () => true} />;
  }
  const first = render(<Composer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  let pending!: Promise<void>;
  act(() => {
    pending = addImage({ type: 'image/png', size: 4,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } as Blob);
  });
  await waitFor(() => expect(h.cacheImageFromBuffer).toHaveBeenCalledOnce());
  first.unmount();
  const reopened = render(<Composer />);
  await waitFor(() => expect(h.editor?.isDestroyed).toBe(false));
  vi.useFakeTimers();
  try {
    act(() => { h.editor!.commands.insertContent('Newest draft'); });
    expect(JSON.stringify(getDraft('composer-regression')?.text)).not.toContain('Newest draft');
    const url = 'cindy-media://blobs/late-composer.png';
    await act(async () => { finishCache({ url }); await pending; });
    expect(h.editor!.getText()).toBe('Newest draft');
    expect(reopened.container.querySelector(`img[src="${url}"]`)).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(getDraft('composer-regression')?.text).toEqual(plainTextToTiptapDoc('Newest draft'));
    expect(getDraft('composer-regression')?.attachments).toEqual([expect.objectContaining({ url })]);
  } finally {
    vi.useRealTimers();
  }
});

// Companion chat 「回复」 bug: the quote appeared above the composer but focus stayed on the
// message's button. Each new quote (also a second one on the same message) is a new request.
it('focuses the editor for each new focus request, not on mount or a repeated value', async () => {
  supplyRangeGeometry();
  const quote = { clientId: 'm1' };
  const view = renderComposer({ focusRequest: quote });
  await waitFor(() => expect(h.editor).not.toBeNull());
  expect(h.editor!.isFocused).toBe(false);
  const outside = document.body.appendChild(document.createElement('button'));
  view.rerender(<ChatInput {...view.props} focusRequest={quote} />);
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={null} />);
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={{ clientId: 'm1' }} />);
  await waitFor(() => expect(h.editor!.isFocused).toBe(true));
  outside.focus();
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={{ clientId: 'm1' }} />);
  await waitFor(() => expect(h.editor!.isFocused).toBe(true));
  outside.remove();
});

// 9bc20cf894 / composerMorphScope: choosing a model used to drop focus to body.
// Generic MorphPopover tests supply their own target and miss ChatInput's wiring.
// Minimal unit input: one real selector choice, then focus returns to the live editor.
it('returns focus to the editor after choosing a model from the real selector', async () => {
  h.realModelSelector = true;
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-old'), sshModel('remote-new')])];
  const onModelDidChange = vi.fn();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addListener: noOp, removeListener: noOp, addEventListener: noOp, removeEventListener: noOp }));
  renderComposer({ hideRuntimeControls: false, sessionId: 'model-focus', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-old',
    initialProviderId: 'openai', initialEffort: 'low', onModelDidChange });
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'newChat.modelSelector.trigger.ariaWithEffort' }));
  const nextModel = await screen.findByRole('option', { name: /remote-new/ });
  await act(async () => {
    fireEvent.pointerDown(nextModel);
    nextModel.focus();
    fireEvent.click(nextModel);
  });
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'newChat.modelSelector.modelListAria' })).toBeNull());
  await waitFor(() => expect(onModelDidChange).toHaveBeenCalledExactlyOnceWith('remote-new'));
  await waitFor(() => expect(document.activeElement).toBe(h.editor!.view.dom));
});

// A prompt preview hides the old draft. Its first key must only dismiss the
// preview; dispatch tests without a preview cannot catch this accidental send.
it('dismisses a preview on Enter without sending or changing the hidden draft', async () => {
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>unsent draft</p>'); });
  view.rerender(<ChatInput {...view.props} previewPrompt="preview suggestion" />);
  expect(screen.getByText('preview suggestion')).toBeTruthy();
  fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' });
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('unsent draft');
  expect(screen.queryByText('preview suggestion')).toBeNull();
});

// Hardware enters through its own subscription, independently of keydown.
// A second action proves the real subscriber is active after preview dismissal.
it.each([
  { type: 'command', commandId: 'composer.submit' },
  { type: 'skill', skillId: 'example', name: 'example' },
  { type: 'composer-text', text: 'hardware text' },
] satisfies InputDeviceRendererAction[])('dismisses a preview before applying hardware $type actions', async action => {
  supplyRangeGeometry();
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const view = renderComposer({ sessionId: 'hardware-preview', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-only',
    initialProviderId: 'openai', initialEffort: 'low' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>unsent draft</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<ChatInput {...view.props} previewPrompt="preview suggestion" />);
  expect(screen.getByText('preview suggestion')).toBeTruthy();
  await act(async () => { dispatchInputDeviceAction(action); });
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('unsent draft');
  expect(screen.queryByText('preview suggestion')).toBeNull();
  await act(async () => { dispatchInputDeviceAction(action); });
  if (action.type === 'command') {
    await waitFor(() => expect(view.props.onSend).toHaveBeenCalledTimes(1));
  } else {
    expect(h.editor!.getText()).toContain(action.type === 'skill' ? '$example' : 'hardware text');
    expect(view.props.onSend).not.toHaveBeenCalled();
  }
});

// The removed source guard did not prove the editor consumed the key. Mount the
// real composer with send enabled: an unmatched slash must close its palette
// without submitting or changing the draft. Reuse this editor/host harness.
it.each(['Enter', 'Tab'])('consumes %s for an empty slash result without sending or editing', async key => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const view = renderComposer({ sessionId: 'slash-empty', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-only',
    initialProviderId: 'openai', initialEffort: 'low' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  const text = '/zzzz-no-such-command';
  await act(async () => {
    h.editor!.commands.setContent('<p>' + text + '</p>');
    h.editor!.commands.setTextSelection(text.length + 1);
  });
  await waitFor(() => expect(screen.getByTestId('test-slash-palette').getAttribute('data-query')).toBe(text.slice(1)));
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(false);
  let allowed = true;
  await act(async () => { allowed = fireEvent.keyDown(h.editor!.view.dom, { key, code: key }); });
  expect(allowed).toBe(false);
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe(text);
  expect(screen.queryByTestId('test-slash-palette')).toBeNull();
});

// A plugin Skill whose plugin is missing is offered in `/`, but choosing it hands
// off to the install flow: it must not insert `/pr`, send, or keep the typed query.
it('hands a plugin Skill setup row to its owner instead of inserting it', async () => {
  const onSelect = vi.fn();
  const view = renderComposer({ sessionId: 'slash-plugin-setup', pluginSkillSetup: {
    entries: [{ skillName: 'pr', description: 'needs GitHub', meta: 'not installed' }], onSelect } });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => {
    h.editor!.commands.setContent('<p>/p</p>');
    h.editor!.commands.setTextSelection(3);
  });
  await waitFor(() => expect(screen.getByTestId('test-slash-palette').getAttribute('data-commands')).toBe('pr'));
  expect(screen.getByTestId('test-slash-palette').getAttribute('data-query')).toBe('p');
  await act(async () => { fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' }); });
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith('pr');
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('');
});

// PR #6196 / pendingFolderMention: the hook-only drag test proves enqueueing,
// but not that an already-mounted editor wakes and consumes the queue. Reuse
// this unit harness with the real hook; choosing another folder must append
// once without reinserting the first. Paths are serialized mention targets.
it('inserts queued folders into the mounted editor when the real attachment hook changes', async () => {
  supplyRangeGeometry();
  function AttachmentComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/workspace/docs')}>Choose docs</button>
      <button onClick={() => attachmentState.addFolderPath('/workspace/src')}>Choose src</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId={null}
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={vi.fn().mockResolvedValue(true)} />
    </>;
  }
  const view = render(<AttachmentComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Choose docs' }));
  await waitFor(() => expect(screen.getByText('docs/')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Choose src' }));
  await waitFor(() => expect(screen.getByText('src/')).toBeTruthy());
  const chips = view.container.querySelectorAll('[data-mention-chip][data-kind="dir"]');
  expect(Array.from(chips, chip => chip.getAttribute('data-path'))).toEqual([
    '/workspace/docs', '/workspace/src',
  ]);
});

// Remote-folder regression: the real editor and send pipeline must never
// send the source folder as a path reference. The ordinary file payload must
// carry the prepared archive, and failed preparation must preserve the draft.
it.each([
  { success: true, pasteOnly: false },
  { success: false, pasteOnly: false },
  { success: true, pasteOnly: true },
])('waits for a remote folder copy before sending ($success, pasteOnly=$pasteOnly)', async ({ success, pasteOnly }) => {
  supplyRangeGeometry();
  let finish!: (result: { ok: true; path: string; size: number } | { ok: false; code: string }) => void;
  h.uploadChatFolder.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onSend = vi.fn().mockResolvedValue(true);
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/docs', new File([], 'docs'))}>Drop folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={onSend} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  if (pasteOnly) {
    fireEvent.paste(h.editor!.view.dom, { clipboardData: {
      items: [{ kind: 'file', getAsFile: () => new File([], 'docs'),
        webkitGetAsEntry: () => ({ isDirectory: true }) }],
      getData: () => '',
    } });
  } else {
    await act(async () => h.editor!.commands.setContent('<p>Read this folder</p>'));
    fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
  }
  await waitFor(() => expect(h.uploadChatFolder).toHaveBeenCalledOnce());
  expect(view.container.querySelector('[data-kind="dir"]')).toBeNull();
  expect(h.editor!.isEditable).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' }));
  await waitFor(() => expect(h.editor!.isEditable).toBe(false));
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => finish(success
    ? { ok: true, path: '/cache/docs.bin', size: 100 }
    : { ok: false, code: 'TRANSFER_FAILED' }));
  if (success) {
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const sent = JSON.stringify(onSend.mock.calls[0]);
    expect(sent).toContain('/cache/docs.bin');
    expect(sent).not.toContain('/controller/docs');
  } else {
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toContain('Read this folder');
    expect(screen.getByText('chat.remoteFile.folderFailed')).toBeTruthy();
    h.uploadChatFolder.mockResolvedValue({ ok: true, path: '/cache/docs.bin', size: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
    await waitFor(() => expect(screen.queryByText('chat.remoteFile.folderFailed')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  }
});

it.each(['cancel', 'switch', 'queue-switch'] as const)('does not submit a late folder after %s', async action => {
  supplyRangeGeometry();
  let finish!: (result: { ok: true; path: string; size: number }) => void;
  h.uploadChatFolder.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onSubmit = vi.fn();
  function RemoteComposer({ device = 'target', queueId = 'queue-a' }: { device?: string; queueId?: string }) {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/docs', new File([], 'docs'))}>Drop folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId={device}
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        queueEditingClientId={action === 'queue-switch' ? queueId : null}
        onQueueEditSubmit={onSubmit}
        disableAutofocus onSend={onSubmit} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
  await waitFor(() => expect(h.uploadChatFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', {
    name: action === 'queue-switch' ? 'newChat.pendingQueue.editSaveAria' : 'newChat.sendButton.send',
  }));
  await waitFor(() => expect(h.editor!.isEditable).toBe(false));
  if (action === 'cancel') {
    fireEvent.click(screen.getByRole('button', { name: 'chat.remoteFile.cancelFolderPreparation' }));
  } else if (action === 'queue-switch') {
    view.rerender(<RemoteComposer queueId="queue-b" />);
  } else {
    view.rerender(<RemoteComposer device="another-computer" />);
  }
  await act(async () => finish({ ok: true, path: '/cache/docs.bin', size: 100 }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(view.container.querySelector('[title="docs"]')).toBeNull();
  expect(view.container.querySelector('[data-kind="dir"]')).toBeNull();
});

it('keeps a folder dragged from the remote task browser as a reference without uploading', async () => {
  supplyRangeGeometry();
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('docs', 'task')}>Reference folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={vi.fn()} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Reference folder' }));
  await waitFor(() => expect(view.container.querySelector('[data-kind="dir"]')?.getAttribute('data-path')).toBe('docs'));
  expect(h.uploadChatFolder).not.toHaveBeenCalled();
});

// PR #6551: the outer drop zone remains usable while Send waits. A second folder
// must join the same message, and its failure must preserve the original draft.
// Unit regression for #6551: the previous Send-only coverage missed queue edits.
// Submit while A is packing, then drop B: both entry points must use the completed
// attachment snapshot (including an otherwise empty edit) or preserve the draft.
// #8084: a 120ms text autosave during A's completion must not restore an older
// attachment list before React commits it. Fake time makes the CI ordering deterministic.
it.each([
  { queueEdit: false, success: true, text: 'Read both folders' },
  { queueEdit: false, success: false, text: 'Read both folders' },
  { queueEdit: true, success: true, text: 'Read both folders' },
  { queueEdit: true, success: true, text: '' },
  { queueEdit: true, success: false, text: 'Read both folders' },
])('waits for folders added during submission ($queueEdit, $success, $text)', async ({ queueEdit, success, text }) => {
  supplyRangeGeometry();
  const completions: Array<(value: unknown) => void> = [];
  h.uploadChatFolder.mockImplementation(() => new Promise(resolve => completions.push(resolve)));
  const onSend = vi.fn().mockResolvedValue(true);
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/a', new File([], 'a'))}>Drop A</button>
      <button onClick={() => attachmentState.addFolderPath('/controller/b', new File([], 'b'))}>Drop B</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        queueEditingClientId={queueEdit ? 'queued-message' : null}
        onQueueEditSubmit={queueEdit ? onSend : undefined}
        disableAutofocus onSend={onSend} />
    </>;
  }
  render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  vi.useFakeTimers();
  try {
    await act(async () => h.editor!.commands.setContent(`<p>${text}</p>`));
    fireEvent.click(screen.getByRole('button', { name: 'Drop A' }));
    expect(completions).toHaveLength(1);
    const submit = screen.getByRole('button', {
      name: queueEdit ? 'newChat.pendingQueue.editSaveAria' : 'newChat.sendButton.send',
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(h.editor!.isEditable).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Drop B' }));
    expect(completions).toHaveLength(2);
    await act(async () => {
      completions[0]({ ok: true, path: '/cache/a.bin', size: 100 });
      // Text autosave can run before React mirrors the newly prepared attachment.
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => completions[1](success
      ? { ok: true, path: '/cache/b.bin', size: 100 }
      : { ok: false, code: 'TRANSFER_FAILED' }));
    if (success) {
      expect(onSend).toHaveBeenCalledOnce();
      const sent = JSON.stringify(onSend.mock.calls[0]);
      expect(sent).toContain('/cache/a.bin');
      expect(sent).toContain('/cache/b.bin');
      expect(sent).not.toContain('/controller/');
    } else {
      expect(onSend).not.toHaveBeenCalled();
      expect(h.editor!.getText()).toContain(text);
    }
  } finally {
    vi.useRealTimers();
  }
});

it('does not let a pending local resource scan repopulate an SSH composer', async () => {
  let finish!: (value: Awaited<ReturnType<typeof scanAtResources>>) => void;
  h.scan.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = renderComposer({ initialWorkingDir: '/workspace' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'test-suggestions' }));
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  h.atPanel = null;
  view.rerender(<ChatInput {...view.props} remoteHostId="ssh-host" />);
  // Synthetic + remains mounted for SSH, unlike the typed-@ panel. Require
  // fresh ready props so a stale captured value cannot make this test pass.
  const currentPanelState = () => h.atPanel?.state;
  await waitFor(() => expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false }));
  await act(async () => finish({ success: true, items: [{ type: 'file', relPath: 'stale.txt', name: 'stale.txt' }], truncated: false }));
  expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false });
});

// 合成「+」面板的关闭焦点(面板搜索框退格收起走 onClose,不经过 MorphPopover 的
// onOpenChange):面板内关闭必须把焦点交还编辑器,否则收合快照判「键盘关闭」、
// 焦点掉回「+」按钮,接着打的字被按钮吃掉;焦点已在面板外则不得抢回。
it('restores editor focus when the suggestion panel closes while focus is inside it', async () => {
  h.atPanelStandin = true;
  supplyRangeGeometry();
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'test-suggestions' }));
  const box = await screen.findByRole('textbox', { name: 'newChat.atMention.typeToSearchFiles' });
  await act(async () => { box.focus(); });
  expect(document.activeElement).toBe(box);
  await act(async () => { h.atPanel!.onClose(); });
  const editorDom = view.container.querySelector('[contenteditable]');
  expect(editorDom).not.toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(editorDom));
});

it('does not steal focus back when the suggestion panel closes after focus moved elsewhere', async () => {
  h.atPanelStandin = true;
  supplyRangeGeometry();
  renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'test-suggestions' }));
  await screen.findByRole('textbox', { name: 'newChat.atMention.typeToSearchFiles' });
  // 用户已把焦点挪到面板外(如 Tab 到其他控件):关闭不得把焦点抢回编辑器。
  const chip = screen.getByRole('button', { name: 'test-suggestions' });
  await act(async () => { chip.focus(); });
  await act(async () => { h.atPanel!.onClose(); });
  expect(document.activeElement).toBe(chip);
});

it('keeps a remote draft with no directory local-scan-free, but searches nonempty queries remotely', async () => {
  renderComposer({ deviceLinkDeviceId: 'remote-device' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>@</p>'); h.editor!.commands.setTextSelection(2); });
  await waitFor(() => expect(h.atPanel).not.toBeNull());
  expect(h.scan).not.toHaveBeenCalled();
  await act(async () => { h.editor!.commands.insertContent('needle'); });
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  expect(h.scan).toHaveBeenLastCalledWith('', expect.any(String), 2000, 'needle', 'remote-device', expect.objectContaining({ includeLocalContext: false, includeTaskHistory: true }));
});

it('restores text, attachments and strokes after an aborted annotated send', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const restoreFiles = vi.fn((files: readonly AttachedFile[]) => [...files]);
  const clearFiles = vi.fn();
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [annotatedImage], hasAttachments: true, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles, restoreFiles,
  };
  // makerChatStore 在烧录失败时返回 false(见 pendingQueueDefer 的中止用例)。
  const onSend = vi.fn().mockResolvedValue(false);
  const view = render(
    <ChatInput sessionId="ssh-annotated" initialWorkingDir="/workspace" runtimeAgentKind="codex"
      vendorKey="codex" deviceLinkDeviceId={null} remoteHostId="builder" attachmentState={attachmentState}
      hideRuntimeControls showFolderPicker={false} disableAutofocus
      initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />,
  );
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Look at the circled button</p>'); });

  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

  const [, , , , sentFiles, , sendOpts] = onSend.mock.calls[0];
  expect(sendOpts).toEqual(expect.objectContaining({ annotationBurnFailure: 'abort' }));
  expect(sentFiles).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);

  // 恢复链路与其它发送失败共用(restoreRemoteOptimisticDraft),正文原样回来、不重复。
  await waitFor(() => expect(h.editor!.getText().trim()).toBe('Look at the circled button'));
  expect(clearFiles).toHaveBeenCalled();
  const restored = restoreFiles.mock.calls.at(-1)?.[0] ?? [];
  expect(restored).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);
});

// PR #6433 / unit: retry a recovered creator draft through the real existing-task
// composer. A same-name project skill must never receive it; rejection must retain
// identity for another retry. Prior annotation tests only recovered plain text.
it('rechecks the built-in creator on every restored-task retry', async () => {
  const intent = { name: 'cindy-plugin-creator', commandName: 'cindy-plugin-creator' };
  const text = '/cindy-plugin-creator Make a plugin';
  h.localProviders = [sshProvider('creator-provider', [sshModel('creator-model')], 'claude-code')];
  const userSkill = { kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' };
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill] });
  saveDraft('composer-regression', { text: plainTextToTiptapDoc(text), attachments: [], builtInSkillIntent: intent });
  const onSend = vi.fn().mockResolvedValue(false);
  renderComposer({ sessionId: 'creator-session', runtimeAgentKind: 'claude-code', vendorKey: 'cc',
    initialWorkingDir: '/fixture/worktree', initialModel: 'creator-model', initialProviderId: 'creator-provider', onSend });
  await waitFor(() => expect(h.editor?.getText().trim()).toBe(text));
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  expect(onSend).not.toHaveBeenCalled();
  expect(h.listAgentSkills.mock.calls).toContainEqual(['claude-code', { workingDir: '/fixture/worktree', forceReload: true }]);
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill,
    { ...userSkill, name: 'cindy:cindy-plugin-creator', builtIn: true },
  ] });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0]).toBe('/cindy:cindy-plugin-creator Make a plugin');
  expect(onSend.mock.calls[0][6].builtInSkillIntent).toEqual({ ...intent, commandName: 'cindy:cindy-plugin-creator' });
  expect(h.listAgentSkills).toHaveBeenCalledWith('claude-code', { workingDir: '/fixture/worktree', forceReload: true });
  await waitFor(() => expect(h.editor?.getText().trim()).toBe(text));
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill] });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
});
