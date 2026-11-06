import { describe, expect, it } from 'vitest';

import { editorOwnsSourceDraft, resolveSourceOwnedComposerExtras } from '../composerSendOwnership';

describe('editorOwnsSourceDraft', () => {
  it('is true while the reused editor still holds the source session document', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: 'session-a',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(true);
  });

  it('is false after restoreNextDraft has swapped the editor to another session', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: 'session-b',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(false);
  });

  it('is false when the editor has been destroyed', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: true,
        editorStorageKey: 'session-a',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(false);
  });

  it('treats a matching undefined key as still owned (draft composer before a session id exists)', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: undefined,
        sourceStorageKey: undefined,
      }),
    ).toBe(true);
  });
});

describe('resolveSourceOwnedComposerExtras', () => {
  it('keeps live extras while the editor still belongs to the source session', () => {
    expect(
      resolveSourceOwnedComposerExtras({
        editorOwnsSource: true,
        liveAttachments: ['live-file'],
        liveComments: ['live-comment'],
        sourceAttachments: ['source-file'],
        sourceComments: ['source-comment'],
      }),
    ).toEqual({
      attachments: ['live-file'],
      comments: ['live-comment'],
    });
  });

  it('does not send the next session extras after restoreNextDraft', () => {
    expect(
      resolveSourceOwnedComposerExtras({
        editorOwnsSource: false,
        liveAttachments: ['session-b-file'],
        liveComments: ['session-b-comment'],
        sourceAttachments: ['session-a-file'],
        sourceComments: ['session-a-comment'],
      }),
    ).toEqual({
      attachments: ['session-a-file'],
      comments: ['session-a-comment'],
    });
  });
});
