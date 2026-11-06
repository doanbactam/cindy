import { BRAND_NAME } from './branding.js';

/** Marker passed as sessions:get arg[1] only by background list reconciliation probes. */
export const DEVICE_LINK_RECONCILIATION_PROBE_MARKER =
  'device-link:sessions-reconciliation-probe';

/** One Codex subscription quota window sent from the controlled desktop. */
export interface MobileCodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}

/** One Codex subscription quota bucket sent to a control-only client. */
export interface MobileCodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: MobileCodexRateLimitWindow | null;
  secondary?: MobileCodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** Display-safe identity for the exact ChatGPT account/workspace used by desktop Codex. */
export interface MobileCodexRateLimitAccount {
  email: string | null;
  accountId: string | null;
  planType: string | null;
}

/** Display-safe metadata for one banked reset credit; its opaque backend id stays on desktop. */
export interface MobileCodexRateLimitResetCredit {
  /** Optional per-credit offer; older hosts/clients keep using the account-level offer. */
  resetOffer?: MobileCodexRateLimitResetOffer | null;
  status: 'available' | 'redeeming' | 'redeemed' | 'unknown';
  resetType: 'codexRateLimits' | 'unknown';
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

/** Desktop-issued, account-bound reset offer used as the idempotency key for one attempt. */
export interface MobileCodexRateLimitResetOffer {
  /** Only retry the existing attempt; do not consume another credit. */
  retryOnly?: boolean;
  idempotencyKey: string;
  /** Unix epoch seconds for the selected banked credit, when details are available. */
  expiresAt: number | null;
  /** Unix epoch milliseconds after which desktop discards this retry key. */
  validUntil: number;
}

/** Full read-only Codex quota view plus an optional manually redeemable reset offer. */
export interface MobileCodexRateLimitsResult {
  /** Absent on older hosts. Settings belong to this computer and exact ChatGPT account. */
  autoUse?: CodexResetAutoUseState;
  /** Echoed account scope; custom-account clients reject unscoped legacy responses. */
  providerId?: string;
  account: MobileCodexRateLimitAccount;
  rateLimits: MobileCodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, MobileCodexRateLimitSnapshot> | null;
  rateLimitResetCredits: {
    availableCount: number;
    credits: MobileCodexRateLimitResetCredit[] | null;
  } | null;
  resetOffer: MobileCodexRateLimitResetOffer | null;
}

export interface CodexResetAutoUseSettings {
  enabled: boolean;
  lowQuota: boolean;
  /** Inclusive days until the weekly quota resets; zero means no time condition. */
  minimumDays: number;
  expiring: boolean;
  expiryMinutes: number;
}

export interface CodexResetAutoUseState {
  /** Opaque account binding, never an auth credential. Required when saving. */
  accountKey: string;
  settings: CodexResetAutoUseSettings;
  customized: boolean;
  lastUsedAt: number | null;
}

/** Stable terminal result for one desktop-issued reset offer. */
export interface MobileCodexRateLimitResetResult {
  providerId?: string;
  outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
  /** Fresh snapshot when the post-consume read succeeded. */
  rateLimits: MobileCodexRateLimitsResult | null;
}

const PERMANENT_REMOTE_ERROR_MARKERS = [
  'REMOTE_DISABLED',
  'CHANNEL_NOT_ALLOWED',
  // 控制端「目标设备无响应」熔断器的快速失败(见 deviceResponsiveness.ts):被控端连续 INVOKE_TIMEOUT 后熔断 open,新请求
  // 本地直拒。必须归为 permanent——否则 withTransientRemoteRetry 会把熔断
  // 快速失败再原地重试 6 次,熔断等于白做。
  'DEVICE_UNRESPONSIVE',
] as const;

const TRANSIENT_REMOTE_ERROR_MARKERS = [
  'DbClient not ready',
  'NOT_CONNECTED',
  'LINK_NOT_OPEN',
  'BACKPRESSURE',
  'DEVICE_LINK_BUSY',
  'DEVICE_OFFLINE',
  'DEVICE_LINK_TIMEOUT',
  'INVOKE_TIMEOUT',
  // HTTP 层 ApiError 的弱网错误码:
  // 超时与离线同属典型瞬时故障,必须能被 withTransientRemoteRetry 识别重试。
  'REQUEST_TIMEOUT',
  'NETWORK_UNAVAILABLE',
  // RN 原生 fetch 离线原文(绕过 api client 的直连路径,如 OSS 直传 PUT):
  // 同样是瞬时故障,且中文兜底文案好过把英文原文透传给用户。
  'Network request failed',
] as const;

const DEFAULT_MAX_ATTEMPTS = 6;

export interface RemoteRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * agent 鉴权失败 message 的固定模板。maker-core 的 claude-code / codex 在
 * startSession / 首次 send 的鉴权门禁抛 AgentNotAuthenticatedError 时统一用
 * `<agentKind> not authenticated: <reason>` 这个格式;reason(no_key 等)目前只
 * 存在于 message 字符串里,不随事件结构化下发,relay 又是哑中继原样透传——手机端
 * 要给出可读提示只能按模板识别。formatRemoteError / throwIpcError 会给部分链路的
 * message 加 `[CODE] ` 头,识别时一并容忍。
 */
const AGENT_NOT_AUTHENTICATED_RE = /^(?:\[[A-Z_]+\] )?(claude-code|codex|pi) not authenticated: ?(.*)$/;

/**
 * agent 未鉴权错误 → 手机端直出文案(桌面端走 i18n,不用这组)。
 *
 * 密钥 / OAuth 都存在被控电脑的 Cindy 里(safeStorage),手机端改不了,文案统一
 * 引导用户回电脑端「设置 → 模型供应商」处理。识别不了的输入返回 null,由调用方
 * 展示原文,不误伤其它错误。
 */
export function describeAgentAuthError(error: string | null | undefined): string | null {
  if (!error) return null;
  const matched = AGENT_NOT_AUTHENTICATED_RE.exec(error.trim());
  if (!matched) return null;
  const agentLabel = matched[1] === 'claude-code' ? 'Claude' : matched[1] === 'pi' ? 'Pi' : 'Codex';
  const goSettings = `请在电脑端 ${BRAND_NAME} 的「设置 → 模型供应商」`;
  switch (matched[2]) {
    case 'no_key':
      return `${agentLabel} 无法使用：电脑端还没有配置可用的 API Key。${goSettings}完成配置后再试。`;
    case 'no_oauth':
      return `${agentLabel} 无法使用：电脑端尚未完成账号授权。${goSettings}重新连接账号后再试。`;
    case 'no_credentials':
      return `${agentLabel} 无法使用：电脑端尚未登录 ${agentLabel}。${goSettings}完成登录后再试。`;
    case 'no_encryption':
      return `${agentLabel} 无法使用：电脑端系统安全存储不可用，读取不到已保存的密钥。请在电脑端检查系统钥匙串（macOS）或系统账户加密（Windows）后重启 ${BRAND_NAME}。`;
    case 'proxy_not_ready':
      return `${agentLabel} 暂时无法使用：电脑端组件尚未就绪。请稍候重试；若持续出现，请重启电脑端 ${BRAND_NAME}。`;
    default:
      // 动态 reason(如 OAuth 被服务端作废的具体原因):不逐一枚举,统一按登录失效引导,
      // 原始 reason 附在句尾便于反馈排查。
      return `${agentLabel} 无法使用：电脑端登录凭证不可用。${goSettings}重新登录后再试。（${matched[2] || 'unknown'}）`;
  }
}

export function formatRemoteError(error: unknown): string {
  const code = readStringField(error, 'code');
  const message = error instanceof Error ? error.message : String(error);
  if (!code || message.includes(code)) return message;
  return `[${code}] ${message}`;
}

/** 控制端熔断器快速失败(目标设备无响应)的识别;code 与 message 两种形态都认。 */
export function isDeviceUnresponsiveRemoteError(error: unknown): boolean {
  const code = readStringField(error, 'code');
  if (code === 'DEVICE_UNRESPONSIVE') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('DEVICE_UNRESPONSIVE');
}

export function isTransientRemoteError(error: unknown): boolean {
  const text = formatRemoteError(error);
  if (PERMANENT_REMOTE_ERROR_MARKERS.some((marker) => text.includes(marker))) return false;
  return TRANSIENT_REMOTE_ERROR_MARKERS.some((marker) => text.includes(marker));
}

export async function withTransientRemoteRetry<T>(
  operation: () => Promise<T>,
  opts: RemoteRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts - 1 && isTransientRemoteError(err);
      if (!canRetry) throw err;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError;
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 3000);
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : null;
}
