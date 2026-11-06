// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discard: vi.fn(), currentId: 'draft-1' as string | null }));
vi.mock('../../provisionalDraftTask', () => ({
  provisionalDraftTaskId: () => mocks.currentId,
  discardProvisionalDraftTask: async (shouldDiscard: () => boolean = () => true) => {
    if (shouldDiscard()) mocks.discard();
  },
}));

import { clearDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { useProvisionalDraftEmptyCleanup } from '../useProvisionalDraftEmptyCleanup';

const draftKey = 'provisional-cleanup-test';
const refreshTitle = vi.fn();
function save(text: string) {
  saveDraft(draftKey, { text: plainTextToTiptapDoc(text), attachments: [] }, { silent: true });
}
function mount() {
  return renderHook(() => useProvisionalDraftEmptyCleanup(draftKey, refreshTitle));
}

// The lifecycle tests never mounted the draft-content subscriber or advanced
// its empty timer. This hook needs jsdom; the non-React provisional task tests
// remain in their existing node file.
describe('provisional draft empty cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.currentId = 'draft-1';
    clearDraft(draftKey);
  });
  afterEach(() => {
    cleanup();
    clearDraft(draftKey);
    vi.useRealTimers();
  });

  it('cancels a pending empty cleanup when typing resumes, but still handles explicit clearing', () => {
    mount();
    act(() => {
      save('');
      vi.advanceTimersByTime(900);
      save('Continue typing');
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).not.toHaveBeenCalled();
    act(() => {
      clearDraft(draftKey);
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).toHaveBeenCalledTimes(1);
  });

  it('removes an empty task when navigating away before the countdown ends', () => {
    const { unmount } = mount();
    act(() => save(''));
    unmount();
    expect(mocks.discard).toHaveBeenCalledTimes(1);
  });
});
