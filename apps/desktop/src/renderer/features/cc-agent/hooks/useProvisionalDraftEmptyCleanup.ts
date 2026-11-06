import { useCallback, useEffect, useRef } from 'react';

import { getDraftPresence, subscribeDraftContent } from '@/lib/composerDraftStore';
import { discardProvisionalDraftTask, provisionalDraftTaskId } from '../provisionalDraftTask';

/** Removes the provisional draft task once its saved draft stays empty. */
export function useProvisionalDraftEmptyCleanup(draftKey: string, refreshTitle: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const isEmpty = useCallback(() => !getDraftPresence(draftKey), [draftKey]);
  const discardIfEmpty = useCallback(() => {
    const id = provisionalDraftTaskId();
    if (id) void discardProvisionalDraftTask(() => provisionalDraftTaskId() === id && isEmpty());
  }, [isEmpty]);
  const armEmptyCheck = useCallback(
    (delayMs: number) => {
      cancel();
      if (!isEmpty()) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        discardIfEmpty();
      }, delayMs);
    },
    [cancel, discardIfEmpty, isEmpty],
  );
  useEffect(() => {
    const unsubscribe = subscribeDraftContent(draftKey, () => {
      if (!provisionalDraftTaskId()) return;
      refreshTitle();
      if (isEmpty()) armEmptyCheck(1_000);
      else cancel();
    });
    return () => {
      unsubscribe();
      const pending = timer.current !== null;
      cancel();
      // Navigating away mid-countdown still removes the empty task.
      if (pending) discardIfEmpty();
    };
  }, [armEmptyCheck, cancel, discardIfEmpty, draftKey, isEmpty, refreshTitle]);

  return { armEmptyCheck };
}
