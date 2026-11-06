/** Remote plugin settings page projection. Author pages receive no host paths or credentials. */
export const PLUGIN_COLLECTION = "plugins";
export interface PluginPageAsset {
  mime: string;
  base64: string;
}
export interface PluginPageFetchResult extends PluginPageAsset {
  status: number;
  revision?: string;
}
export interface PluginPageFile {
  path: string;
  mime: string;
  size: number;
}
export interface PluginPageEvent {
  sequence: number;
  channel: string;
  data: unknown;
}
export interface PluginPageConfirm {
  id: string;
  pluginId: string;
  title: string;
  body: string;
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
  expiresAt: number;
}
export interface PluginPagePoll {
  events: PluginPageEvent[];
  confirms: PluginPageConfirm[];
  notifications: Array<{ id: string; text: string }>;
  directories?: PluginDirectoryRequest[];
  /** Optional; old controllers ignore requests and Host timeout cancels them. */
  modelPickers?: PluginModelPickerRequest[];
}

export interface PluginModelSelection {
  /** Optional Agent location relative to the plugin's execution computer. */
  agentDeviceId?: string;
  agentKind: 'cc' | 'codex' | 'pi';
  providerId: string;
  model: string;
  effort: string;
  fastMode: boolean | 'ultrafast';
}

export function isPluginModelSelection(value: unknown): value is PluginModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof v[key] === 'string' &&
    (v[key] as string).trim().length > 0 && (v[key] as string).length <= max;
  return Object.keys(v).every(key => ['agentKind', 'providerId', 'model', 'effort', 'fastMode', 'agentDeviceId'].includes(key)) &&
    (v.agentDeviceId === undefined || text('agentDeviceId', 128)) &&
    ['cc', 'codex', 'pi'].includes(String(v.agentKind)) && text('providerId', 128) && text('model', 256) &&
    typeof v.effort === 'string' && v.effort.length <= 32 &&
    (typeof v.fastMode === 'boolean' || v.fastMode === 'ultrafast');
}

/** Native Host model selection; never forwarded into the plugin document. */
export interface PluginModelPickerRequest {
  /** Opt in only when the caller can execute remote routes. Old requests remain local. */
  allowRemote?: boolean;
  requestId: string;
  ghostId: string;
  ghostName: string;
  initial?: PluginModelSelection;
  expiresAt: number;
}
/** Trusted native picker presentation, never forwarded into an author page. */
export interface PluginDirectoryRequest {
  id: string;
  pluginId: string;
  ghostName: string;
  purpose: string | null;
  expiresAt: number;
}
// Pages preload code/assets; large user media remains streamed through owned media/library resources.
export const PLUGIN_PAGE_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Trusted native settings; no directory, credentials or provider execution routing on the wire. */
export interface PluginTaskPreferences {
  revision: string;
  config: {
    agentKind?: "cc" | "codex" | "pi";
    model?: string;
    providerId?: string;
    effort?: string;
    fastMode?: boolean | 'ultrafast';
    permissionMode?: string;
  };
  permissionModes: string[];
  defaultPermissionMode: string;
}
