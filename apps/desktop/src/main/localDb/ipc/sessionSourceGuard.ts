import { throwIpcError } from '../../utils/ipcValidate.js';

/**
 * Renderer may not choose a task purpose. Bot tasks go through the Bot
 * lifecycle service; the former Cindy Make purpose no longer exists.
 */
export function assertRendererSessionSourceAllowed(input: { source: unknown }): void {
  if (input.source === undefined) return;
  throwIpcError(
    'UNSUPPORTED_CAPABILITY',
    'Bot task creation is only available through the Bot lifecycle service',
  );
}
