/**
 * ChatInput reuses one Tiptap editor across session switches. A send the user
 * already requested must still go to that source session, even after the live
 * editor has been swapped to the next task's draft.
 */

export function editorOwnsSourceDraft(input: {
  editorDestroyed: boolean;
  editorStorageKey: string | undefined;
  sourceStorageKey: string | undefined;
}): boolean {
  return !input.editorDestroyed && input.editorStorageKey === input.sourceStorageKey;
}

/**
 * After a session switch the live attachment/comment refs belong to the next
 * task. A send that started on the source session must keep using the source
 * draft extras, never the newly restored composer.
 */
export function resolveSourceOwnedComposerExtras<TAttachment, TComment>(input: {
  editorOwnsSource: boolean;
  liveAttachments: readonly TAttachment[];
  liveComments: readonly TComment[];
  sourceAttachments?: readonly TAttachment[];
  sourceComments?: readonly TComment[];
}): { attachments: TAttachment[]; comments: TComment[] } {
  if (input.editorOwnsSource) {
    return {
      attachments: [...input.liveAttachments],
      comments: [...input.liveComments],
    };
  }
  return {
    attachments: [...(input.sourceAttachments ?? [])],
    comments: [...(input.sourceComments ?? [])],
  };
}
