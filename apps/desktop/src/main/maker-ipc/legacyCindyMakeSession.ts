import { isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * Cindy Make has been removed. Tasks it created stay in the local database
 * (history and usage are kept), but they must never start, resume or receive
 * input again — whichever channel tries.
 */
export function assertCindyMakeSessionAvailable(source: string | null | undefined): void {
  if (isCindyMakeSource(source)) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make is no longer available');
  }
}

/**
 * Every local create/resume funnel passes bootstrapSession; the persisted
 * `sessions.source` is the only trusted purpose marker.
 */
export async function assertPersistedSessionAvailable(
  o: { id?: string },
  readSource: (sessionId: string) => Promise<string | null>,
): Promise<void> {
  if (typeof o.id !== 'string' || !o.id) return;
  assertCindyMakeSessionAvailable(await readSource(o.id));
}
