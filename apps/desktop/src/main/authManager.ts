/**
 * authManager.ts
 * ---------------------------------------------------------------------------
 * All authentication logic lives here in the main process:
 *
 * - auth-server login flow (verification codes, PKCE browser redirects, account selection)
 * - Token storage (safeStorage for refresh token, in-memory for access token)
 * - Automatic access token refresh scheduling
 * - Logout (API + state cleanup)
 * - Auth state notification to renderer via IPC
 *
 * The renderer never touches tokens directly — it calls IPC endpoints
 * exposed by this module and receives state updates via 'auth:state-change'.
 */

import { BrowserWindow, net, safeStorage, app, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { machineIdSync } from 'node-machine-id';
import {
  AuthApiError,
  CindyAuthClient,
  retryAfterDeadline,
  parseAccountDeletionReceiptRecord,
  parseAuthSessionRecord,
  serializeAccountDeletionReceiptRecord,
  serializeAuthSessionRecord,
  type AuthMembership,
  type AuthRegion,
  type AuthTokenPair,
  type AccountMembership,
  type AccountDeletionAvailability,
  type AccountDeletionStatus,
} from '@cindy/auth-client';
import { readReloginFlag, clearReloginFlag, enableUncustomizedBetaChannel } from './updateService';
import { linuxCredentialFailureFields } from './linuxPasswordStore.js';
import { probeBetaManifest } from './manifestService';
import { isEnableBetaUserCustomized, readUpdateChannelSettings } from './updateChannelStore';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import * as canaryFlagStore from './canaryFlagStore';
import { decodeAccessTokenOrgSlug } from './authTokenClaims';
import { AuthRefreshBackoff } from './authRefreshBackoff';
import { getProviderSecretStore } from './secrets/providerSecretStore.js';
import {
  runRefreshWithReplacementRetry,
  resolveSessionExpiredReason,
  type RefreshFailureAction,
  type RefreshFailureInfo,
  type RefreshFetchResult,
  type SessionExpiredReason,
} from './authRefreshFailure';
import {
  awaitWithStartupTimeout,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
  resolveColdStartTimeoutRecovery,
} from './authStartupGate';
import { syncCanaryFlagAfterAuth } from './canaryFlagSync';
import {
  maybeEnableNonXdOrgBetaDefault,
  maybeEnableXdOrgBetaDefault,
  shouldAttemptOrgBetaDefault,
} from './xdOrgBetaDefault';
import { canRestoreAuthSessionForMembership } from './authRealmPolicy';
import { reconcileSavedAccountMetadata, type StoredAccountMetadata } from './authAccountMetadata';
import {
  loggedOutAccountKeySet,
  restoreLoggedOutVaultAccount,
} from './authAccountLogoutPolicy';
// dev-only 登录 scenario harness(implementation-plan Step 0 WHAT4):静态 import
// (main 禁运行时动态 import),生产构建由 vite alias 把整模块替换为空 stub
// (vite.main.config.ts),运行时另有 app.isPackaged guard 双保险。
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

import { createLogger } from './logger';
import { requestErrorMessage } from './requestErrorMessage';
import { AuthOwnerChangeShellGate } from './authOwnerChangeShellGate';
import {
  isGhostSkillProjectionBoundaryStableForOwner,
  withGhostSkillProjectionOwnerCommit,
  withGhostSkillProjectionReadOnlyOwner,
  withStableOwnerBoundaryMutation,
} from './authBoundaryQuarantine.js';
import { getResolvedMainLocale } from './i18n';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';
import {
  activateClientEndpointRealm,
  getClientEndpoint,
  getClientEndpointForRealm,
  loadClientEndpointsForRealm,
  resetClientEndpointRealm,
} from './clientEndpointsService.js';
import {
  parseDesktopAccountKey,
  type DesktopAccountDeletionChallenge,
} from '../shared/authIpc';
import {
  accountFreeDataOwnerId,
  activeOwnerScopeKey,
  adoptAccountFreeDataOwner,
  beginAppSessionBoundary,
  commitActiveAppSession,
  commitVolatileAppSession,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  LOCAL_DATA_OWNER_ID,
  readPersistedAppSessionMode,
  type AppSessionMode,
} from './appSessionState.js';
import {
  claimLegacyOwnerNamespace,
  recordLegacyGhostMigrationResult,
} from './ownerNamespaceMigration.js';
import {
  migrateLocalNativeProviderAuthBindings,
  readLegacyNativeProviderAuthOwner,
  recoverPendingLegacyNativeProviderAuthOwner,
  releaseLegacyNativeProviderAuthOwner,
  reserveCommittedLegacyNativeProviderAuthOwner,
  reserveLegacyNativeProviderAuthOwnerDetailed,
} from './maker-host/nativeProviderAuthBinding.js';
import {
  recoverPendingLocalProfileDataOwner,
  releaseLocalProfileDataOwner,
  reserveCommittedLocalProfileDataOwnerDetailed,
  reserveLocalProfileDataOwnerDetailed,
} from './localProfileDataMigration.js';
import { buildSafeStorageIssueMeta } from './safeStorageIssueLog.js';
import { createCredentialStoreHealth } from './authCredentialStoreHealth';
import { withCrossProcessLock } from './device-link/crossProcessLock';
import {
  StableOwnerPostCommitCoordinator,
  type StableOwnerPostCommitTask,
} from './stableOwnerPostCommit.js';

const log = createLogger('authManager');

// #1687:持久凭证库(safeStorage)故障升级状态机。运行时刷新的 transient-unreadable
// 分支喂失败,成功读到持久会话喂恢复;连续跨过阈值才置 unavailable 并随 AuthState
// 广播,renderer 据此显示可操作提示(检查钥匙串授权 / 重新登录)。
const credentialStoreHealth = createCredentialStoreHealth();

async function claimLegacyNamespaceForVerifiedUser(userId: string): Promise<void> {
  try {
    const result = await claimLegacyOwnerNamespace({
      mode: 'cloud',
      dataOwnerId: userId,
      user: { id: userId },
    });
    recordLegacyGhostMigrationResult(userId, result);
  } catch (error) {
    recordLegacyGhostMigrationResult(userId, { status: 'partial', moved: 0, conflicts: 0 });
    log.warn('legacy owner namespace claim failed; continuing with scoped storage', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const AUTH_REGION: AuthRegion =
  import.meta.env.VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn';
// 端点惰性读取(勿固化成模块级常量):远程清单在 app.ready 内解析,
// 顶层求值会把值钉死在烘焙值上。clientEndpointsService 的烘焙值已含 dev fallback。
// 默认读取构建区域；组织 SSO 发现后按冻结的 session realm 读取对应清单。
function authServerUrl(realm: AuthRegion = activeAuthRealm): string {
  return getClientEndpointForRealm(realm, 'authApiBaseUrl');
}
const AUTH_SESSION_KEY = 'cindy_auth_session_v1';
const AUTH_ACCOUNT_VAULT_KEY = 'cindy_auth_accounts_v1';
const AUTH_ACCOUNT_VAULT_LOCK_FILE = '.cindy-auth-accounts-v1.lock';
const AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY = 'cindy_auth_account_logout_tombstones_v1';
// The aggregate vault stays readable by v1 clients for explicit-login
// compatibility. Per-membership logout tombstones live in a separate key that
// older clients never read or rewrite, so their Passport sync cannot resurrect
// an account explicitly logged out by a newer client.
const AUTH_ACCOUNT_VAULT_VERSION = 2 as const;
const AUTH_ACCOUNT_LOGOUT_TOMBSTONES_VERSION = 1 as const;
const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'cindy_auth_refresh_token';
const ACCOUNT_DELETION_RECEIPT_KEY = 'cindy_auth_account_deletion_receipt';
const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'cindy_auth_account_refresh_token';
const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_EFFORT = 'medium';

// ── Types ───────────────────────────────────────────────────────────────────

// 2026-07 产品侧 me 路由退役:身份完全以 auth-server membership 为准,不再
// 请求主 server `/api/user/me`。原产品增强字段的去向:
//  - isCanary → 登录后从 oauth-broker `/api/user/feature-flags` 单独读取,
//    落 main 进程本地标记并通过 AuthState 独立投影给 renderer,不混入 User;
//  - feishuOpenId → 退役,飞书登录已整体下线,身份锚(identityAnchor)只写 email;
//  - role(产品级 admin)→ 退役,唯一消费是侧栏头像角标(纯装饰),一并移除。
export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  /** auth-server membership context. */
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  /**
   * 组织 slug(access token 的 orgSlug claim,ctx=org 时 auth-server 注入)。
   * 组织的稳定标识(域名派生、全局唯一,如 'xd'),与 orgId(cuid)/orgName(显示名)
   * 不同,适合做企业功能分流的配置键。个人身份或旧 token 缺 claim 时为 null。
   * membership 响应不含此字段,由 snapshotAuthState 出口统一从 access token 解码注入。
   */
  orgSlug: string | null;
  /** 企业 logo(auth console 组织设置上传);个人身份或未设置为 null。 */
  orgLogoUrl: string | null;
  passportId: string;
}

/**
 * Main-process-only auth user. Keep the raw membership display name separate
 * from `User.name`, whose UI fallback may be an email address or "Cindy".
 */
interface CurrentUser extends User {
  membershipDisplayName: string;
}

interface StoredResourceSession {
  realm: AuthRegion;
  refreshToken: string;
  metadata: StoredAccountMetadata;
  lastUsedAt: number;
}

interface StoredPassportSession {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: StoredAccountMetadata[];
}

interface AuthAccountVault {
  version: typeof AUTH_ACCOUNT_VAULT_VERSION;
  activeAccountKey: string | null;
  resources: Record<string, StoredResourceSession>;
  passports: Record<string, StoredPassportSession>;
  /** Memberships explicitly logged out on this device stay hidden until a fresh login restores them. */
  loggedOutAccountKeys?: string[];
  /**
   * Durable signed-out owner marker. The vault is the crash-consistent owner
   * record, so this must win over a compatibility session left behind by an
   * interrupted logout until another account is explicitly activated.
   */
  signedOutAt?: number;
}

export interface AuthState {
  user: User | null;
  /** Stable application session. Local is an app session, not cloud authentication. */
  mode: AppSessionMode;
  /** Owner for local databases and owner-scoped private state. */
  dataOwnerId: string | null;
  /** Main-owned owner boundary generation used to fence late renderer pushes. */
  ownerGeneration: number;
  /** True only for the transient signed-out projection published before an owner boundary commits. */
  ownerBoundaryPending?: boolean;
  /** Local and cloud sessions may enter the main application. */
  canEnterApp: boolean;
  isAuthenticated: boolean;
  /** 当前账号是否加入 Canary 发布通道；不属于身份资料。 */
  isCanary: boolean;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都会有值 */
  deviceId: string;
  /** Main has an encrypted receipt that can query a pending deletion without auth. */
  hasAccountDeletionReceipt: boolean;
  /** One-shot successful-login notice for a deletion that was cancelled by signing in. */
  accountDeletionRestored: boolean;
  /**
   * 持久凭证库(safeStorage)连续多个刷新周期不可用(#1687)。true 时登录态无法
   * 续期持久化,renderer 应显示可操作提示;成功读写一次后自动回 false。
   */
  credentialStoreUnavailable: boolean;
}

export interface AuthInitializeOptions {
  /**
   * 冷启动 refresh 超过 UI 等待上限时触发。renderer 仍会先拿到未登录兜底态，
   * 但 dev restart 必须继续等待这个最终结果：迟到登录后还要观察 localDb migration。
   */
  onColdStartPending?: (completion: Promise<AuthState>) => void;
}

type RefreshResponse = AuthTokenPair;

interface AuthErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

type AuthRefreshResult = RefreshFetchResult<RefreshResponse | AuthErrorResponse>;

type AccountSwitchTeardown = (context: {
  previousUserId: string;
  nextUserId: string;
}) => void | Promise<void>;

/** Releases every account-scoped runtime before terminal local sign-out. */
type AuthSessionTeardown = (reason: string) => void | Promise<void>;
type ProjectionRepairTeardown = (reason: string) => void | Promise<void>;

let accountSwitchTeardown: AccountSwitchTeardown | null = null;
let authSessionTeardown: AuthSessionTeardown | null = null;
let projectionRepairTeardown: ProjectionRepairTeardown | null = null;

const stableOwnerPostCommitCoordinator = new StableOwnerPostCommitCoordinator({
  snapshot: () => {
    const session = getActiveAppSession();
    return {
      scopeKey: activeOwnerScopeKey(),
      dataOwnerId: session.dataOwnerId,
      stable:
        !isAppSessionBoundaryPending() &&
        isGhostSkillProjectionBoundaryStableForOwner(session.dataOwnerId),
    };
  },
  warn: (message, meta) => log.warn(message, meta),
});

/** Queue optional owner-scoped provisioning without holding authentication or the app shell. */
export function requestStableOwnerPostCommit(reason: string): void {
  if (isPassiveSharedUserDataInstance()) return;
  void stableOwnerPostCommitCoordinator.ensure(reason);
}

// ── Module-level state ──────────────────────────────────────────────────────

let accessToken: string | null = null;
let currentUser: CurrentUser | null = null;
/** 已登录会话区域；安装包区域 AUTH_REGION 始终不变。 */
let activeAuthRealm: AuthRegion = AUTH_REGION;
/**
 * 当前登录流使用的区域。个人登录固定为安装包区域，企业发现后改为组织区域；
 * 账号选择、绑定等后续步骤继续复用，reset/cancel/失败回收时清除。
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<boolean> | null = null;
const refreshBackoff = new AuthRefreshBackoff();
let sessionInvalidationPromise: Promise<void> | null = null;
// Real owner change / logout: keep the renderer fail-closed even if a late
// notifyRenderer() races the teardown. Same-owner Ghost repair must not set
// this — that was the 55-minute /login flash.
const ownerChangeShellGate = new AuthOwnerChangeShellGate();

function enterOwnerChangeShellPending(): void {
  ownerChangeShellGate.enter();
}

function leaveOwnerChangeShellPending(): void {
  ownerChangeShellGate.leave();
}

function isOwnerChangeShellPending(): boolean {
  return ownerChangeShellGate.isPending();
}
/**
 * 设备标识。默认绑定物理机(machineIdSync)。
 *
 * dev-only 覆盖:设了 `XDT_DEVICE_ID_OVERRIDE` 则用它——用于在同一台机器上跑多个
 * desktop 实例模拟「多设备」(device-link 跨设备远程控制本地联调)。deviceId 只是
 * 同账号下区分设备的标识、非鉴权凭证(鉴权走 auth-server 签发的 JWT),覆盖无安全风险。
 */
const deviceId = process.env.XDT_DEVICE_ID_OVERRIDE?.trim() || machineIdSync();

let accountDeletionRestoredNoticePending = false;
// Set only after auth-server has accepted deletion. The credential guard keeps a
// late confirmation from tearing down another account or realm selected meanwhile.
let confirmedAccountDeletionCredential: {
  identity: string;
  realm: AuthRegion;
} | null = null;

function createAuthClient(
  realm: AuthRegion = activeAuthRealm,
): CindyAuthClient {
  // 登录 scenario harness 注入点(仅 client 构造参数,不替换 client、不 fake 方法;
  // zod schema/错误归一/REGION_MISMATCH 路径全真)。guard:!app.isPackaged +
  // XDT_LOGIN_SCENARIO(值域见 implementation-plan 附录 A,经 restart 脚本
  // devEnvPrefix 白名单透传)。
  const scenarioFetch = resolveLoginScenarioFetch({
    devModeActive: !app.isPackaged,
    scenario: process.env.XDT_LOGIN_SCENARIO,
    region: realm,
  });
  return new CindyAuthClient({
    baseUrl: authServerUrl(realm),
    region: realm,
    deviceId,
    clientType: 'desktop',
    locale: getResolvedMainLocale(),
    fetch: scenarioFetch ?? (async (input, init) => net.fetch(input, init as RequestInit)),
    onRequestError: (apiPath, status, error) => {
      log.warn('auth request failed', apiPath, { realm, status }, requestErrorMessage(error));
    },
  });
}

// ── passive 共享实例闸门 ────────────────────────────────────────────────────

/**
 * 共享 userData 的 passive dev 实例(`--preserve-running` / `--passive` 非 isolated)。
 *
 * 这类实例复用 primary 的登录态,但**不得销毁整机共享的 auth 持久状态**——与
 * owner-namespace 迁移(ownerNamespaceMigration.ts)、localDb schema
 * (localDb/index.ts)同一条契约。受约束的是「删除 / 作废 / 消费」这类破坏性动作:
 *   1. 磁盘 refresh token 文件(整机一份,删了 primary 下次续期就被踢);
 *   2. 服务端 refresh token(按 (user, device) 一对一存,passive 与 primary 共用
 *      同一 deviceId,调登出会把 primary 的那份一起作废);
 *   3. relogin marker(一次性、整机一份,被 passive 消费掉 primary 就再也看不到);
 *   4. canary flag 与账号删除 receipt(账号派生状态,删掉会让 primary 拉错 manifest
 *      或丢掉进行中的删除挑战)。
 *
 * **续期不在约束内**:passive 照常排 refresh timer,轮换后正常 writeSafe 写回新
 * token。轮换写入的是有效凭证,primary 侧由 replacement-retry 消化;停掉续期反而
 * 会让 passive 的 access token 过期后无自愈路径(详见 scheduleRefresh 的注释)。
 *
 * 2026-07-27 事故:两个 MIGRATE_FAILED 的 passive 实例在 LocalDbGate fatal 界面点
 * 「返回登录」,logout 删掉整机 refresh token,正在使用的 primary 在下一个 refresh
 * 周期(隔了 19 / 46 分钟)被判定 credential-lost 强制重登。同源事故 2026-07-23 已
 * 发生过一次,当时只把静默半死改成明确弹重登(见 authSessionExpiredDetection.test.ts),
 * 没有堵住 passive 的销毁权。
 *
 * packaged 恒不设置该 env(index.ts 启动时对 packaged / isolated-sandbox 显式
 * delete 兜底,防 ambient env 污染),线上零影响。env 由解析后的 profileKind
 * 不是 isolated-sandbox 且 passive 落地,覆盖正式目录与非隔离 custom 共库。
 */
export function isPassiveSharedUserDataInstance(): boolean {
  return !app.isPackaged && process.env.XDT_PASSIVE_SHARED_USER_DATA === '1';
}

/**
 * passive 实例「本进程已登出」的墓碑(进程内,不落盘)。
 *
 * passive 登出保留磁盘 token(那是 primary 的),于是登出后任何 initialize() ——
 * 副窗 mount、右侧栏子窗口、renderer reload —— 都会读到仍在的 token 把本进程
 * 冷启动登回去,还顺手轮换一次共享 token。有了墓碑,「只登出本进程」才是稳定的:
 * 直到用户在本进程显式登录或重启进程为止。
 */
let passiveLocalSignOut = false;

/**
 * DEVICE_MISMATCH 后本进程已确认配不上磁盘 token。token 留给真正的设备,
 * 但 initialize() 不能反复拿同一枚去撞 401。直到显式登录或进程重启为止。
 */
let foreignDeviceLocalSignOut = false;

// ── safeStorage helpers ─────────────────────────────────────────────────────

const SAFE_STORAGE_DIR = () => path.join(app.getPath('userData'), 'safe-storage');

// #871 可观测性:safeStorage 不可用 / 解密失败此前被静默折叠成 null,用户在系统
// 钥匙串弹窗点「拒绝」后的降级完全不可诊断。按「原因 × key」各记一次(readSafe 在
// 热路径上高频调用,不能每次都写;只按原因去重会掩盖「单个凭证损坏 vs 整个后端
// 不可用」的区分,review 反馈)。错误只记 code/name,不记 message——fs 错误的
// message 携带 userData 绝对路径,不该进保留 30 天的日志;密文/明文更不落。
const safeStorageIssueLogged = new Set<string>();
let credentialEncryptionUnavailable = false;
let credentialEncryptionFailureLogged = false;

function isCredentialEncryptionAvailable(): boolean {
  const available = safeStorage.isEncryptionAvailable();
  // Only consume a real credential operation after Electron is ready. Filesystem
  // contention and an individual bad ciphertext do not require a process restart.
  if (app.isReady()) credentialEncryptionUnavailable = !available;
  if (!available && !credentialEncryptionFailureLogged) {
    credentialEncryptionFailureLogged = true;
    let screenState = 'unknown';
    try {
      if (app.isReady()) screenState = powerMonitor.getSystemIdleState(1);
    } catch {
      // Diagnostics must not change credential read behavior.
    }
    let backend: string | undefined;
    try {
      backend = (
        safeStorage as { getSelectedStorageBackend?: () => string }
      ).getSelectedStorageBackend?.();
    } catch {
      backend = 'unavailable';
    }
    let passwordStoreSwitch: string | undefined;
    try {
      const commandLine = (app as {
        commandLine?: {
          hasSwitch?: (name: string) => boolean;
          getSwitchValue?: (name: string) => string;
        };
      }).commandLine;
      if (commandLine?.hasSwitch?.('password-store')) {
        const fromCommandLine = commandLine.getSwitchValue?.('password-store');
        if (typeof fromCommandLine === 'string') passwordStoreSwitch = fromCommandLine;
      }
    } catch {
      passwordStoreSwitch = undefined;
    }
    if (passwordStoreSwitch === undefined) {
      const prefix = '--password-store=';
      const arg = process.argv.find((item) => item.startsWith(prefix));
      if (arg) passwordStoreSwitch = arg.slice(prefix.length);
    }
    log.warn('credential encryption backend unavailable', {
      appReady: app.isReady(),
      screenState,
      electronVersion: process.versions.electron,
      ...linuxCredentialFailureFields({
        platform: process.platform,
        env: process.env,
        backend,
        passwordStoreSwitch,
      }),
    });
  }
  return available;
}

/** Main-process recovery signal; never expose credentials or probe the keychain. */
export function needsCredentialProcessRecovery(): boolean {
  return (
    credentialEncryptionUnavailable &&
    accessToken === null &&
    getActiveAppSession().mode === 'signed-out' &&
    !isPassiveSharedUserDataInstance()
  );
}

function logSafeStorageIssueOnce(reason: string, key: string, err?: unknown): void {
  const issueKey = `${reason}:${key}`;
  if (safeStorageIssueLogged.has(issueKey)) return;
  safeStorageIssueLogged.add(issueKey);
  log.warn(`safeStorage ${reason}`, buildSafeStorageIssueMeta(key, err));
}

function readSafe(key: string): string | null {
  try {
    if (!isCredentialEncryptionAvailable()) {
      logSafeStorageIssueOnce('encryption unavailable (read)', key);
      return null;
    }
    const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf-8');
    return safeStorage.decryptString(Buffer.from(content, 'base64'));
  } catch (err) {
    logSafeStorageIssueOnce('decrypt failed', key, err);
    return null;
  }
}

// Startup recovery must preserve existing records, including atomic backups and
// logout tombstones. Only definite absence permits the fresh-profile login UI;
// checking filenames does not probe the encryption backend or decrypt anything.
function hasPotentiallyPersistedAuthCredentials(): boolean {
  return [
    AUTH_SESSION_KEY,
    AUTH_ACCOUNT_VAULT_KEY,
    AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
    LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
    LEGACY_ACCOUNT_REFRESH_TOKEN_KEY,
    LEGACY_REFRESH_TOKEN_KEY,
  ].some((key) =>
    ['', '.bak'].some((suffix) => {
      try {
        fs.accessSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc${suffix}`), fs.constants.F_OK);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      }
    }),
  );
}

/**
 * 区分「凭证文件确实不存在」与「暂时读不出来」。
 *
 * `readSafe` 把三种情况都折叠成 null:加密不可用、文件不存在、读取/解密抛错。
 * 只有「加密可用且文件确实不在」才能作为「凭证被外部实例清除」的判据;其余
 * (密钥链暂时不可用、瞬时 I/O、解密失败)必须按瞬时失败处理——否则一次
 * 密钥链抖动就会把仍持有有效会话的用户强制登出。
 *
 * 注意不能用 existsSync:它对 EPERM/EACCES 等访问错误同样返回 false,会把
 * 「没权限读」误判成「已被删除」。这里用 accessSync 并只认 ENOENT(文件或
 * 父目录确定不存在)为真缺席,其它错误一律按瞬时故障。
 */
function isPersistedSecretAbsent(key: string): boolean {
  try {
    if (!isCredentialEncryptionAvailable()) return false;
    fs.accessSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`), fs.constants.F_OK);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

function writeSafe(key: string, value: string): boolean {
  try {
    if (!isCredentialEncryptionAvailable()) {
      logSafeStorageIssueOnce('encryption unavailable (write)', key);
      return false;
    }
    const dir = SAFE_STORAGE_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.enc`),
      safeStorage.encryptString(value).toString('base64'),
      'utf-8',
    );
    return true;
  } catch (err) {
    logSafeStorageIssueOnce('encrypt/persist failed', key, err);
    return false;
  }
}

/**
 * The aggregate account vault needs atomic replacement because one partial
 * write would otherwise discard every saved resource and Passport session.
 * During the Windows backup-swap fallback, readers use the old backup rather
 * than trying to restore it while the writer still owns the vault lock.
 */
function readAtomicSafe(key: string): string | null {
  try {
    if (!isCredentialEncryptionAvailable()) {
      logSafeStorageIssueOnce('encryption unavailable (atomic read)', key);
      return null;
    }
    const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
    let content: string;
    try {
      content = fs.readFileSync(filepath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      content = fs.readFileSync(`${filepath}.bak`, 'utf-8');
    }
    return safeStorage.decryptString(Buffer.from(content, 'base64'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logSafeStorageIssueOnce('atomic decrypt failed', key, err);
    return null;
  }
}

/**
 * Keep an unreadable encrypted record available for an explicit replacement
 * to roll back to. The payload is still ciphertext; it is never parsed or
 * exposed to the renderer.
 */
function readAtomicSafeCiphertext(key: string): string | null {
  try {
    if (!isCredentialEncryptionAvailable()) return null;
    return readAtomicFileSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logSafeStorageIssueOnce('atomic ciphertext snapshot failed', key, err);
    return null;
  }
}

function writeAtomicSafeCiphertext(key: string, ciphertext: string): boolean {
  try {
    atomicWriteFileSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`), ciphertext);
    return true;
  } catch (err) {
    logSafeStorageIssueOnce('atomic ciphertext restore failed', key, err);
    return false;
  }
}

function isAtomicPersistedSecretAbsent(key: string): boolean {
  if (!isCredentialEncryptionAvailable()) return false;
  return atomicPersistedSecretPresence(key) === 'absent';
}

/** File presence only. Encryption availability must not turn a missing file into an existing one. */
function atomicPersistedSecretPresence(key: string): 'absent' | 'present' | 'unknown' {
  const filepath = path.join(SAFE_STORAGE_DIR(), key + '.enc');
  for (const candidate of [filepath, filepath + '.bak']) {
    try {
      fs.accessSync(candidate, fs.constants.F_OK);
      return 'present';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return 'unknown';
    }
  }
  return 'absent';
}

function logUnreadableEncryptedRecord(
  key: string,
  presentMessage: string,
  absentMessage: string,
): void {
  const absentAndUnavailable =
    !isCredentialEncryptionAvailable() && atomicPersistedSecretPresence(key) === 'absent';
  log.warn(absentAndUnavailable ? absentMessage : presentMessage);
}

function writeAtomicSafe(key: string, value: string): boolean {
  try {
    if (!isCredentialEncryptionAvailable()) {
      logSafeStorageIssueOnce('encryption unavailable (atomic write)', key);
      return false;
    }
    atomicWriteFileSync(
      path.join(SAFE_STORAGE_DIR(), `${key}.enc`),
      safeStorage.encryptString(value).toString('base64'),
    );
    return true;
  } catch (err) {
    logSafeStorageIssueOnce('atomic encrypt/persist failed', key, err);
    return false;
  }
}

function removeAtomicSafeOrThrow(key: string): void {
  const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
  try {
    // Remove the backup first so deleting the main file cannot resurrect an
    // older vault on the next atomic write.
    for (const candidate of [`${filepath}.bak`, filepath]) {
      try {
        fs.unlinkSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    logSafeStorageIssueOnce('atomic delete failed', key, error);
    throw new AuthApiError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      503,
      'Could not clear saved account credentials',
    );
  }
}

function removeSafe(key: string): void {
  try {
    fs.unlinkSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`));
  } catch {
    // ENOENT is fine
  }
}

function emptyAuthAccountVault(): AuthAccountVault {
  return {
    version: AUTH_ACCOUNT_VAULT_VERSION,
    activeAccountKey: null,
    resources: {},
    passports: {},
  };
}

function readAuthAccountLogoutTombstones(options: { recoverInvalid?: boolean } = {}): string[] {
  const raw = readAtomicSafe(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
  if (raw === null) {
    if (isAtomicPersistedSecretAbsent(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY)) return [];
    logUnreadableEncryptedRecord(
      AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
      'encrypted auth logout tombstones are temporarily unreadable',
      'encrypted auth logout tombstones are absent and the credential backend is unavailable',
    );
    if (options.recoverInvalid) return [];
    throw new AuthApiError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      503,
      'Saved account logout state is temporarily unavailable',
    );
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      accountKeys?: unknown;
    };
    if (
      parsed.version !== AUTH_ACCOUNT_LOGOUT_TOMBSTONES_VERSION ||
      !Array.isArray(parsed.accountKeys)
    ) {
      throw new Error('unsupported auth logout tombstones');
    }
    const accountKeys = parsed.accountKeys.filter(
      (key): key is string => parseDesktopAccountKey(key) !== null,
    );
    if (accountKeys.length !== parsed.accountKeys.length) {
      throw new Error('invalid auth logout tombstone key');
    }
    return [...new Set(accountKeys)];
  } catch (error) {
    log.warn(
      'encrypted auth logout tombstones are invalid; refusing to read saved accounts',
      error,
    );
    if (options.recoverInvalid) return [];
    throw new AuthApiError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      503,
      'Saved account logout state could not be read safely',
    );
  }
}

function writeAuthAccountLogoutTombstones(vault: AuthAccountVault): boolean {
  const accountKeys = [...new Set(vault.loggedOutAccountKeys ?? [])];
  if (accountKeys.length === 0) {
    try {
      removeAtomicSafeOrThrow(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
      return true;
    } catch {
      return false;
    }
  }
  return writeAtomicSafe(
    AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
    JSON.stringify({ version: AUTH_ACCOUNT_LOGOUT_TOMBSTONES_VERSION, accountKeys }),
  );
}

function accountVaultKey(realm: AuthRegion, membershipId: string): string {
  return JSON.stringify([realm, membershipId]);
}

function passportVaultKey(realm: AuthRegion, passportId: string): string {
  return JSON.stringify([realm, passportId]);
}

function isStoredAccountMetadata(value: unknown): value is StoredAccountMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredAccountMetadata>;
  return (
    typeof item.membershipId === 'string' &&
    typeof item.passportId === 'string' &&
    typeof item.displayName === 'string' &&
    (item.email === null || typeof item.email === 'string') &&
    (item.avatarUrl === null || typeof item.avatarUrl === 'string') &&
    (item.kind === 'personal' || item.kind === 'org') &&
    (item.role === 'owner' || item.role === 'admin' || item.role === 'member') &&
    (item.orgId === null || typeof item.orgId === 'string') &&
    (item.orgName === null || typeof item.orgName === 'string') &&
    (item.orgLogoUrl === null || typeof item.orgLogoUrl === 'string')
  );
}

function readAuthAccountVault(
  options: {
    allowUnreadable?: boolean;
    recoverInvalid?: boolean;
    allowUnreadableLogoutTombstones?: boolean;
  } = {},
): AuthAccountVault {
  let persistedLogoutKeys: string[];
  try {
    persistedLogoutKeys = readAuthAccountLogoutTombstones({
      recoverInvalid: options.recoverInvalid,
    });
  } catch (error) {
    if (options.allowUnreadableLogoutTombstones) {
      // An explicit logout may replace the damaged tombstone record, but must
      // retain every still-readable account in the aggregate vault.
      persistedLogoutKeys = [];
    } else if (options.allowUnreadable) {
      return emptyAuthAccountVault();
    } else {
      throw error;
    }
  }
  const raw = readAtomicSafe(AUTH_ACCOUNT_VAULT_KEY);
  if (raw === null) {
    if (isAtomicPersistedSecretAbsent(AUTH_ACCOUNT_VAULT_KEY)) {
      return persistedLogoutKeys.length > 0
        ? { ...emptyAuthAccountVault(), loggedOutAccountKeys: persistedLogoutKeys }
        : emptyAuthAccountVault();
    }
    logUnreadableEncryptedRecord(
      AUTH_ACCOUNT_VAULT_KEY,
      'encrypted auth account vault exists but is temporarily unreadable',
      'encrypted auth account vault is absent and the credential backend is unavailable',
    );
    if (options.allowUnreadable) return emptyAuthAccountVault();
    throw new AuthApiError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      503,
      'Saved account credentials are temporarily unavailable',
    );
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthAccountVault>;
    const persistedVersion = (parsed as { version?: unknown }).version;
    if (
      (persistedVersion !== 1 && persistedVersion !== AUTH_ACCOUNT_VAULT_VERSION) ||
      !parsed.resources ||
      typeof parsed.resources !== 'object' ||
      Array.isArray(parsed.resources) ||
      !parsed.passports ||
      typeof parsed.passports !== 'object' ||
      Array.isArray(parsed.passports) ||
      (parsed.loggedOutAccountKeys !== undefined && !Array.isArray(parsed.loggedOutAccountKeys)) ||
      (parsed.signedOutAt !== undefined && typeof parsed.signedOutAt !== 'number')
    ) {
      throw new Error('unsupported auth account vault');
    }
    const resources: Record<string, StoredResourceSession> = {};
    for (const [key, candidate] of Object.entries(parsed.resources)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        if (options.allowUnreadable || options.recoverInvalid) continue;
        throw new Error('invalid saved resource credential');
      }
      const item = candidate as Partial<StoredResourceSession>;
      if (
        (item.realm !== 'cn' && item.realm !== 'global') ||
        typeof item.refreshToken !== 'string' ||
        !isStoredAccountMetadata(item.metadata) ||
        typeof item.lastUsedAt !== 'number'
      ) {
        if (options.allowUnreadable || options.recoverInvalid) continue;
        throw new Error('invalid saved resource credential');
      }
      resources[key] = item as StoredResourceSession;
    }
    const passports: Record<string, StoredPassportSession> = {};
    for (const [key, candidate] of Object.entries(parsed.passports)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        if (options.allowUnreadable || options.recoverInvalid) continue;
        throw new Error('invalid saved Passport credential');
      }
      const item = candidate as Partial<StoredPassportSession>;
      if (
        (item.realm !== 'cn' && item.realm !== 'global') ||
        typeof item.passportId !== 'string' ||
        typeof item.accountRefreshToken !== 'string' ||
        !Array.isArray(item.memberships)
      ) {
        if (options.allowUnreadable || options.recoverInvalid) continue;
        throw new Error('invalid saved Passport credential');
      }
      const memberships = item.memberships.filter(isStoredAccountMetadata);
      if (
        !options.allowUnreadable &&
        !options.recoverInvalid &&
        memberships.length !== item.memberships.length
      ) {
        throw new Error('invalid saved Passport membership');
      }
      passports[key] = {
        realm: item.realm,
        passportId: item.passportId,
        accountRefreshToken: item.accountRefreshToken,
        memberships,
      };
    }
    const embeddedLogoutKeys = (parsed.loggedOutAccountKeys ?? []).filter(
      (key): key is string => parseDesktopAccountKey(key) !== null,
    );
    if (
      !options.allowUnreadable &&
      !options.recoverInvalid &&
      embeddedLogoutKeys.length !== (parsed.loggedOutAccountKeys?.length ?? 0)
    ) {
      throw new Error('invalid logged-out account key');
    }
    const loggedOutKeys = new Set([...persistedLogoutKeys, ...embeddedLogoutKeys]);
    const active = typeof parsed.activeAccountKey === 'string' ? parsed.activeAccountKey : null;
    // Never infer an explicit restore from an active Resource projection: a
    // crash between the tombstone write and aggregate replacement can leave
    // that projection stale. Only an explicit login transaction may clear a
    // logout tombstone.
    const loggedOutAccountKeys = [...loggedOutKeys];
    return {
      version: AUTH_ACCOUNT_VAULT_VERSION,
      activeAccountKey: active && resources[active] && !loggedOutKeys.has(active) ? active : null,
      resources,
      passports,
      ...(loggedOutAccountKeys.length > 0 ? { loggedOutAccountKeys } : {}),
      ...(typeof parsed.signedOutAt === 'number' ? { signedOutAt: parsed.signedOutAt } : {}),
    };
  } catch (error) {
    if (options.recoverInvalid) {
      log.warn('encrypted auth account vault is invalid; recovering it for explicit login', error);
      return persistedLogoutKeys.length > 0
        ? { ...emptyAuthAccountVault(), loggedOutAccountKeys: persistedLogoutKeys }
        : emptyAuthAccountVault();
    }
    log.warn('encrypted auth account vault is invalid; ignoring it without deleting', error);
    if (options.allowUnreadable) return emptyAuthAccountVault();
    throw new AuthApiError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      503,
      'Saved account credentials could not be read safely',
    );
  }
}

function writeAuthAccountVault(
  vault: AuthAccountVault,
  options: { replaceUnreadableLogoutTombstones?: boolean } = {},
): boolean {
  const previousLogoutRaw = readAtomicSafe(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
  const previousLogoutWasAbsent =
    previousLogoutRaw === null && isAtomicPersistedSecretAbsent(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
  const previousLogoutUnreadable = previousLogoutRaw === null && !previousLogoutWasAbsent;
  const previousLogoutCiphertext = previousLogoutUnreadable
    ? readAtomicSafeCiphertext(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY)
    : null;
  if (
    previousLogoutUnreadable &&
    (!options.replaceUnreadableLogoutTombstones || previousLogoutCiphertext === null)
  ) {
    return false;
  }
  // Persist the tombstone before the legacy-compatible aggregate. If the
  // process stops between these writes, a new client fails closed instead of
  // briefly re-enumerating an account that was explicitly logged out.
  if (!writeAuthAccountLogoutTombstones(vault)) return false;
  // Keep the aggregate payload at the legacy version so an older client can
  // still recover an explicit login without discarding the other saved
  // accounts. New clients continue to read the optional logout tombstones,
  // while logout removes the signed-out membership from the stored Passport
  // projection so older clients cannot enumerate it from local data.
  if (writeAtomicSafe(AUTH_ACCOUNT_VAULT_KEY, JSON.stringify({ ...vault, version: 1 }))) {
    return true;
  }
  try {
    if (previousLogoutWasAbsent) {
      removeAtomicSafeOrThrow(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
    } else if (
      previousLogoutRaw !== null &&
      !writeAtomicSafe(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, previousLogoutRaw)
    ) {
      log.warn('failed to restore auth logout tombstones after vault write failure');
    } else if (
      previousLogoutUnreadable &&
      previousLogoutCiphertext !== null &&
      !writeAtomicSafeCiphertext(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, previousLogoutCiphertext)
    ) {
      log.warn('failed to restore unreadable auth logout tombstones after vault write failure');
    }
  } catch (error) {
    log.warn('failed to restore auth logout tombstones after vault write failure', error);
  }
  return false;
}

function writeAuthAccountVaultOrThrow(
  vault: AuthAccountVault,
  options: { replaceUnreadableLogoutTombstones?: boolean } = {},
): void {
  if (writeAuthAccountVault(vault, options)) return;
  throw new AuthApiError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    503,
    'Could not persist saved account credentials',
  );
}

function authAccountVaultLockPath(): string {
  return path.join(app.getPath('userData'), AUTH_ACCOUNT_VAULT_LOCK_FILE);
}

function accountVaultLockError(reason: 'busy' | 'unavailable'): AuthApiError {
  return new AuthApiError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    503,
    `Saved account credentials are temporarily ${reason}`,
  );
}

/**
 * Every saved-account read/modify/write goes through one shared-userData lock.
 * Resource refresh is intentionally allowed in passive instances, so an
 * in-process queue alone cannot prevent it from overwriting a primary
 * instance's concurrently added account or rotated Passport.
 */
async function transactAuthAccountVault<T>(
  operation: (vault: AuthAccountVault) => T | Promise<T>,
  afterPersist: (result: T) => void | Promise<void> = () => undefined,
  options: {
    recoverInvalidForExplicitLogin?: boolean;
    allowUnreadableLogoutTombstones?: boolean;
    replaceUnreadableLogoutTombstones?: boolean;
    waitWhileBusyAfterRotation?: boolean;
  } = {},
): Promise<T> {
  type Attempt = { kind: 'busy' } | { kind: 'committed'; result: T };
  let reportedBusyWait = false;
  for (;;) {
    const attempt: Attempt = await withCrossProcessLock(
      authAccountVaultLockPath(),
      { label: 'auth-account-vault', waitMs: 5_000 },
      async (status) => {
        if (!status.held) {
          if (status.reason === 'busy' && options.waitWhileBusyAfterRotation) {
            return { kind: 'busy' };
          }
          throw accountVaultLockError(status.reason);
        }
        const previousRaw = readAtomicSafe(AUTH_ACCOUNT_VAULT_KEY);
        const previousWasAbsent =
          previousRaw === null && isAtomicPersistedSecretAbsent(AUTH_ACCOUNT_VAULT_KEY);
        const previousLogoutRaw = readAtomicSafe(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
        const previousLogoutWasAbsent =
          previousLogoutRaw === null &&
          isAtomicPersistedSecretAbsent(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
        const previousLogoutUnreadable = previousLogoutRaw === null && !previousLogoutWasAbsent;
        const previousLogoutCiphertext = previousLogoutUnreadable
          ? readAtomicSafeCiphertext(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY)
          : null;
        const vault = readAuthAccountVault({
          recoverInvalid: options.recoverInvalidForExplicitLogin,
          allowUnreadableLogoutTombstones: options.allowUnreadableLogoutTombstones,
        });
        const result = await operation(vault);
        writeAuthAccountVaultOrThrow(vault, {
          replaceUnreadableLogoutTombstones:
            options.replaceUnreadableLogoutTombstones || options.recoverInvalidForExplicitLogin,
        });
        try {
          // Keep the shared-userData lock through the active-session write,
          // runtime teardown and final owner commit. Cancellation or any local
          // boundary failure restores the complete pre-transition vault before
          // another process can observe or extend the partial account switch.
          await afterPersist(result);
          return { kind: 'committed', result };
        } catch (error) {
          if (previousWasAbsent) {
            removeAtomicSafeOrThrow(AUTH_ACCOUNT_VAULT_KEY);
          } else if (
            previousRaw !== null &&
            !writeAtomicSafe(AUTH_ACCOUNT_VAULT_KEY, previousRaw)
          ) {
            throw new AuthApiError(
              'CREDENTIAL_STORE_UNAVAILABLE',
              503,
              'Could not restore saved account credentials after a failed account switch',
            );
          }
          if (previousLogoutWasAbsent) {
            removeAtomicSafeOrThrow(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
          } else if (
            previousLogoutRaw !== null &&
            !writeAtomicSafe(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, previousLogoutRaw)
          ) {
            throw new AuthApiError(
              'CREDENTIAL_STORE_UNAVAILABLE',
              503,
              'Could not restore saved account logout state after a failed account switch',
            );
          } else if (
            previousLogoutUnreadable &&
            previousLogoutCiphertext !== null &&
            !writeAtomicSafeCiphertext(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, previousLogoutCiphertext)
          ) {
            throw new AuthApiError(
              'CREDENTIAL_STORE_UNAVAILABLE',
              503,
              'Could not restore unreadable account logout state after a failed account switch',
            );
          }
          throw error;
        }
      },
    );
    if (attempt.kind === 'committed') return attempt.result;
    // A refresh token has already rotated on the server, so a busy lock is not
    // a retryable failure: abandoning the replacement would strand that saved
    // account on the consumed generation. Keep yielding until the current
    // owner releases the lock; unavailable storage still fails immediately.
    if (!reportedBusyWait) {
      reportedBusyWait = true;
      log.warn('waiting for the account vault lock to persist a rotated credential');
    }
  }
}

async function mutateAuthAccountVault<T>(
  operation: (vault: AuthAccountVault) => T | Promise<T>,
  options: {
    allowUnreadableLogoutTombstones?: boolean;
    replaceUnreadableLogoutTombstones?: boolean;
    waitWhileBusyAfterRotation?: boolean;
  } = {},
): Promise<T> {
  return transactAuthAccountVault(operation, () => undefined, options);
}

async function clearAuthAccountVault(
  customize: (vault: AuthAccountVault) => void = () => undefined,
  afterPersist: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await withCrossProcessLock(
    authAccountVaultLockPath(),
    { label: 'auth-account-vault-clear', waitMs: 5_000 },
    async (status) => {
      if (!status.held) throw accountVaultLockError(status.reason);
      // Explicit logout must remain available even if an old vault is
      // undecryptable. Replace it with a fresh fail-closed owner record rather
      // than reading or deleting it first.
      const vault = emptyAuthAccountVault();
      vault.activeAccountKey = null;
      vault.resources = {};
      vault.passports = {};
      vault.signedOutAt = Date.now();
      customize(vault);
      writeAuthAccountVaultOrThrow(vault, { replaceUnreadableLogoutTombstones: true });
      await afterPersist();
    },
  );
}

function metadataFromMembership(
  membership: AuthMembership | AccountMembership,
  passportId: string,
): StoredAccountMetadata {
  return {
    membershipId: membership.id,
    passportId,
    displayName: membership.displayName,
    email: membership.email,
    avatarUrl: membership.avatarUrl ?? null,
    kind: membership.kind,
    role: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
  };
}



function writeResourceSessionToVault(
  vault: AuthAccountVault,
  pair: AuthTokenPair,
  realm: AuthRegion,
  passportId: string,
  options: {
    markActive?: boolean;
    lastUsedAt?: number;
    restoreLoggedOutAccount?: boolean;
  } = {},
): void {
  const key = accountVaultKey(realm, pair.membership.id);
  if (options.restoreLoggedOutAccount) restoreLoggedOutVaultAccount(vault, key);
  vault.resources[key] = {
    realm,
    refreshToken: pair.refreshToken,
    metadata: metadataFromMembership(pair.membership, passportId),
    lastUsedAt: options.lastUsedAt ?? Date.now(),
  };
  if (options.markActive !== false) {
    delete vault.signedOutAt;
    vault.activeAccountKey = key;
  }
}

/** Persist a rotated Passport only while the request still owns the token it consumed. */


type ActiveRefreshCredentialCommit = 'active' | 'inactive' | 'discarded';

async function commitDesktopRefreshCredentials(
  pair: AuthTokenPair,
  realm: AuthRegion,
  requestedRefreshToken: string,
  options: {
    allowUnclaimedVault?: boolean;
    validateBeforeWrite?: () => void;
  } = {},
): Promise<ActiveRefreshCredentialCommit> {
  return transactAuthAccountVault(
    (vault) => {
      options.validateBeforeWrite?.();
      const key = accountVaultKey(realm, pair.membership.id);
      const latestSession = readPersistedAuthSession();
      const requestedTokenStillStored =
        (latestSession?.realm === realm && latestSession.refreshToken === requestedRefreshToken) ||
        (vault.activeAccountKey === key &&
          vault.resources[key]?.realm === realm &&
          vault.resources[key]?.refreshToken === requestedRefreshToken) ||
        (realm === AUTH_REGION &&
          readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) === requestedRefreshToken);
      const canClaimUninitializedVault =
        options.allowUnclaimedVault === true &&
        vault.activeAccountKey === null &&
        typeof vault.signedOutAt !== 'number' &&
        Object.keys(vault.resources).length === 0 &&
        !loggedOutAccountKeySet(vault).has(key);
      const stillOwnsActiveSession =
        requestedTokenStillStored && (vault.activeAccountKey === key || canClaimUninitializedVault);
      const passportId = pair.membership.passportId;
      if (
        passportId &&
        (stillOwnsActiveSession || vault.resources[key]?.refreshToken === requestedRefreshToken)
      ) {
        // A passive stale refresh may still rotate account A's resource token
        // after the primary has committed account B. Preserve A for a future
        // explicit switch, but never let that late result reclaim activeAccountKey.
        writeResourceSessionToVault(vault, pair, realm, passportId, {
          markActive: stillOwnsActiveSession,
        });
      }
      if (stillOwnsActiveSession) return 'active';
      return vault.resources[key] ? 'inactive' : 'discarded';
    },
    (commit) => {
      if (commit === 'active') {
        writePersistedAuthSessionOrThrow(pair.refreshToken, realm);
      }
    },
    { waitWhileBusyAfterRotation: true },
  ).catch((error) => {
    log.warn('refresh credential save failed', { realm }, requestErrorMessage(error));
    throw error;
  });
}

async function rememberUpdatedMembershipMetadata(
  membership: AuthMembership,
  realm: AuthRegion,
  passportId: string,
): Promise<void> {
  if (isPassiveSharedUserDataInstance()) return;
  await mutateAuthAccountVault((vault) => {
    reconcileSavedAccountMetadata(vault, {
      realm,
      passportId,
      memberships: [metadataFromMembership(membership, passportId)],
      passportMode: 'patch-known',
    });
  });
}

async function removeVaultAccount(accountKey: string): Promise<void> {
  await mutateAuthAccountVault((vault) => {
    delete vault.resources[accountKey];
    if (vault.activeAccountKey === accountKey) vault.activeAccountKey = null;
  });
}

function readPersistedAuthSession() {
  return parseAuthSessionRecord(readSafe(AUTH_SESSION_KEY));
}

/**
 * Repair a missing compatibility projection from the aggregate vault. When
 * both exist but diverge, preserve both: a rollback build can rotate only the
 * compatibility session, while an interrupted new-build commit can leave the
 * vault newer. The refresh retry path asks the server which one is stale.
 */
async function reconcileDesktopActiveAuthSession(): Promise<
  ReturnType<typeof readPersistedAuthSession>
> {
  return withCrossProcessLock(
    authAccountVaultLockPath(),
    { label: 'auth-account-vault-reconcile', waitMs: 5_000 },
    async (status) => {
      if (!status.held) throw accountVaultLockError(status.reason);
      const vault = readAuthAccountVault();
      const session = readPersistedAuthSession();
      if (typeof vault.signedOutAt === 'number') {
        // Account logout persists this owner tombstone before removing the
        // compatibility projection. If the process stopped between those
        // writes, finish the projection cleanup without ever refreshing it.
        removeSafe(AUTH_SESSION_KEY);
        removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);
        removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
        removeSafe(LEGACY_REFRESH_TOKEN_KEY);
        return null;
      }
      const activeResource = vault.activeAccountKey
        ? vault.resources[vault.activeAccountKey]
        : undefined;
      if (!activeResource) return session;
      if (!session) {
        writePersistedAuthSessionOrThrow(activeResource.refreshToken, activeResource.realm);
        return {
          version: 1,
          realm: activeResource.realm,
          refreshToken: activeResource.refreshToken,
        };
      }
      // A rollback build can rotate only the compatibility session. When the
      // two durable projections disagree, preserve both as refresh candidates;
      // the server's definitive response decides which generation is stale.
      return session;
    },
  );
}

function readPersistedRefreshToken(realm = activeAuthRealm): string | null {
  const session = readPersistedAuthSession();
  return session?.realm === realm ? session.refreshToken : null;
}

function writePersistedAuthSession(refreshToken: string, realm = activeAuthRealm): boolean {
  const written = writeSafe(AUTH_SESSION_KEY, serializeAuthSessionRecord(realm, refreshToken));
  // v1 记录是唯一权威;legacy 只是给尚未升级的实例看的从属副本,写成功才镜像。
  if (written) mirrorLegacyResourceRefreshToken(refreshToken, realm);
  return written;
}

function writePersistedAuthSessionOrThrow(refreshToken: string, realm = activeAuthRealm): void {
  if (writePersistedAuthSession(refreshToken, realm)) return;
  throw new AuthApiError(
    'CREDENTIAL_STORE_UNAVAILABLE',
    503,
    'Could not persist the active account session',
  );
}

/**
 * 过渡期镜像:把轮换出的新 refresh token 同步回写 legacy 凭证文件。
 *
 * 服务端 refresh token 按 (user, device) 一对一存,共享 userData 的双开实例共用
 * 同一 deviceId——任一实例续期,另一实例手上那枚立刻作废。这本该由
 * replacement-retry 兜住(「磁盘上已有别人写的新 token」就追上去重试),但
 * `LEGACY_RESOURCE_REFRESH_TOKEN_KEY` → `AUTH_SESSION_KEY` 的格式迁移打断了这条
 * 兜底:新版轮换后只写 v1,旧版实例只会读 legacy,于是它读到的永远是自己那枚死
 * token,把可自愈的竞态判成确定性失效并强制重登。
 *
 * 2026-07-29 事故:packaged 0.1.20(legacy)与含 #748 的 dev(v1)共享 userData 双开,
 * dev 在 07:42 续期,packaged 07:46 的 refresh 拿 INVALID_REFRESH_TOKEN,两次
 * replacement recheck 读 legacy 都读到自己那枚旧 token,弹「登录已过期」。
 *
 * 只在 legacy 文件**已经存在**时镜像:它不在就说明没有旧版实例在消费它(或已被
 * 独占启动的新版清理),不要凭空复活一份凭证文件。
 *
 * 只镜像 realm === AUTH_REGION 的 session:legacy 格式是裸 token、不带 realm,旧版
 * 按自己的构建区解释。把对端区域的 token 写进去,旧版会拿它去请求本区 auth-server,
 * 比不镜像更糟。
 *
 * 「检查存在 → 写入」不是原子的(与 writeSafe / removeSafeIfUnchanged 同一限制,见
 * removeSafeIfUnchanged 的注释):另一个共享 userData 的实例可能刚好在这中间登出、或者
 * 再轮换一次。写完回头核对权威记录是否仍是本次写入的那一条:
 *   - 已被清掉(登出)→ 从属副本不能比权威记录活得更久;
 *   - 已前进到更新的一枚 → 本次镜像的那枚此刻已经失效,留着正是这个 PR 要消灭的
 *     「旧版只读 legacy → 拿到死 token → 被强制重登」。
 * 两种情况都按 compare-and-delete 撤回(只删自己刚写的那一枚)。
 *
 * 读不出权威记录但文件还在(密钥链抖动 / 瞬时 IO)时**不撤回**:那是不确定状态,而本模块
 * 对不确定一律不做破坏性动作(同 isPersistedSecretAbsent / removeSafeIfUnchanged)。
 */
function mirrorLegacyResourceRefreshToken(refreshToken: string, realm: AuthRegion): void {
  if (realm !== AUTH_REGION) return;
  if (isPersistedSecretAbsent(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)) return;
  // 已经是同一枚就不写:省一次落盘,也不因无意义的 mtime 变化干扰 CAS 删除的身份校验。
  if (readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) === refreshToken) return;
  if (!writeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken)) {
    // 密钥链暂时不可用 / 权限 / 磁盘:v1 已经是最新的,但只读 legacy 的旧版实例这轮
    // 追不上,下次轮换会再镜像一次。如实记录,不要让它变成静默的半可用状态。
    log.warn(
      'failed to mirror the rotated refresh token into the legacy credential file; older shared-userData instances may not catch up until the next rotation',
    );
    return;
  }
  const rollBackMirror = (reason: string): void => {
    const rolledBack = removeSafeIfUnchanged(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, refreshToken);
    log.warn(
      `${reason} while mirroring the legacy refresh token — rolled back the mirror (${rolledBack})`,
    );
  };
  if (isPersistedSecretAbsent(AUTH_SESSION_KEY)) {
    rollBackMirror('persisted auth session disappeared');
    return;
  }
  const latestSession = readSafe(AUTH_SESSION_KEY);
  // 读不出来(null 但文件在)→ 不确定,保留镜像。
  if (latestSession !== null && latestSession !== serializeAuthSessionRecord(realm, refreshToken)) {
    rollBackMirror('persisted auth session advanced past the mirrored token');
  }
}

/**
 * 确定性失效后清掉磁盘上所有「已确认死掉」的 refresh token —— account vault、
 * v1 兼容记录与 legacy 从属副本各清一次。
 *
 * `deadTokens` 是本轮被服务端拒过的全部 token(按首次尝试顺序)。必须逐一比对而不是只
 * 认最初那一枚:本轮一旦从另一个来源追赶过,磁盘上现存的就是清单里较晚的那一枚,只拿
 * 最初的 token 做 compare-and-delete 会一律 `changed`,把已确认失效的凭证留在盘上——
 * 只读 legacy 的旧版实例继续拿它撞 INVALID_REFRESH_TOKEN 被强制重登,本进程的读侧回退
 * 也会把它当成替换候选。
 *
 * compare-and-delete 语义不变:内容不在清单里就说明另一个实例刚写入了替换凭证,不属于
 * 本次清理范围,保留。
 *
 * 运行期 `clearAuth` 已经会删这两个文件(那是显式登出 / 会话过期的整体清理),所以这里
 * 只补冷启动确定性失效这一条路径;passive 实例的守卫在调用点。
 */
async function clearConfirmedDeadRefreshTokens(
  realm: AuthRegion,
  deadTokens: readonly string[],
): Promise<void> {
  try {
    await mutateAuthAccountVault((vault) => {
      const activeKey = vault.activeAccountKey;
      const activeResource = activeKey ? vault.resources[activeKey] : undefined;
      if (
        !activeKey ||
        activeResource?.realm !== realm ||
        !deadTokens.includes(activeResource.refreshToken)
      ) {
        return;
      }
      delete vault.resources[activeKey];
      vault.activeAccountKey = null;
    });
  } catch (error) {
    log.error(
      'cold-start refresh: failed to remove the confirmed-dead active Resource from the account vault',
      error,
    );
  }
  let sessionOutcome: RemoveIfUnchangedResult = 'changed';
  for (const token of deadTokens) {
    sessionOutcome = removeSafeIfUnchanged(
      AUTH_SESSION_KEY,
      serializeAuthSessionRecord(realm, token),
    );
    if (sessionOutcome !== 'changed') break;
  }
  switch (sessionOutcome) {
    case 'deleted':
      log.warn(
        'cold-start refresh: definitive credential failure — cleared persisted auth session',
      );
      break;
    case 'changed':
      // 磁盘会话不是本轮判定过的任何一枚(另一个实例写入了新 token 或 realm):不能删。
      log.warn(
        'cold-start refresh: definitive credential failure, but the persisted auth session changed meanwhile — keeping the replacement',
      );
      break;
    case 'failed':
      // 删除真的失败了:凭证仍在盘上,下次启动会再判一次。不能报成已清理。
      log.error(
        'cold-start refresh: definitive credential failure, but deleting the persisted auth session failed — it is still on disk',
      );
      break;
  }

  // legacy 从属副本只在与安装包区域一致时才由本进程镜像 / 解释。
  if (realm !== AUTH_REGION) return;
  let legacyOutcome: RemoveIfUnchangedResult = 'changed';
  for (const token of deadTokens) {
    legacyOutcome = removeSafeIfUnchanged(LEGACY_RESOURCE_REFRESH_TOKEN_KEY, token);
    if (legacyOutcome !== 'changed') break;
  }
  if (legacyOutcome === 'changed') {
    log.warn(
      'cold-start refresh: legacy refresh token is none of the tokens rejected this run — keeping the replacement written by another app instance',
    );
    return;
  }
  if (legacyOutcome === 'failed') {
    log.error(
      'cold-start refresh: failed to delete the mirrored legacy refresh token — it is still on disk and older instances may keep retrying it',
    );
  }
}

/**
 * replacement-retry 的读侧对偶:交出磁盘上**全部**凭证来源的当前值,按优先级排列。
 *
 * 镜像只能解决「新版轮换 → 旧版追赶」;反向(旧版实例轮换后只写 legacy,本进程读 v1
 * 读到的仍是已作废的旧值)同样会误判确定性失效,所以读侧也必须认 legacy。v1 排前面:
 * 它带 realm、是本版本的权威记录;legacy 仅在与安装包区域一致时才可解释。
 *
 * 这里刻意**不**折叠成单个候选。选择要在 `runRefreshWithReplacementRetry` 里做——只有
 * 它知道本轮哪些 token 已经被服务端拒过。在这里先按优先级挑一枚,会让 v1 里那枚已失效
 * 的 token 挤掉 legacy 里真正有效的那枚,最终以确定性失效收场并连带删掉有效凭证。
 */
function readStoredRefreshTokenCandidates(realm: AuthRegion): readonly (string | null)[] {
  const vault = readAuthAccountVault();
  const activeResource = vault.activeAccountKey
    ? vault.resources[vault.activeAccountKey]
    : undefined;
  return [
    readPersistedRefreshToken(realm),
    activeResource?.realm === realm ? activeResource.refreshToken : null,
    realm === AUTH_REGION ? readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) : null,
  ];
}

function readActiveVaultRefreshCandidate(): {
  accountKey: string;
  realm: AuthRegion;
  refreshToken: string;
} | null {
  const vault = readAuthAccountVault();
  const accountKey = vault.activeAccountKey;
  const resource = accountKey ? vault.resources[accountKey] : undefined;
  return accountKey && resource
    ? { accountKey, realm: resource.realm, refreshToken: resource.refreshToken }
    : null;
}

function readPersistedAccountDeletionReceipt() {
  const raw = readSafe(ACCOUNT_DELETION_RECEIPT_KEY);
  const record = parseAccountDeletionReceiptRecord(raw);
  if (record) return record;
  // Older builds stored the opaque receipt directly. Those receipts could only
  // have been issued by the build region, so preserve that deterministic
  // migration rule without trying another region.
  return raw && !raw.trimStart().startsWith('{')
    ? { version: 1 as const, realm: AUTH_REGION, receiptToken: raw }
    : null;
}

function writePersistedAccountDeletionReceipt(
  receiptToken: string,
  realm: AuthRegion,
  authIdentity: string,
): boolean {
  return writeSafe(
    ACCOUNT_DELETION_RECEIPT_KEY,
    serializeAccountDeletionReceiptRecord(realm, receiptToken, authIdentity),
  );
}

/**
 * 只在磁盘内容仍等于 `expected` 时删除(compare-and-delete)。
 *
 * 共享 userData 下,「判定这枚 token 已失效」与「执行删除」之间存在窗口:另一个
 * 实例可能刚好在这中间写入了有效的替换 token。无条件删就会把别人刚写的有效凭证
 * 删掉——正是本 PR 要防的失败模式。冷启动路径尤其危险:它带 transient 重试与
 * replacement recheck,从判定到删除可能隔了数秒。
 *
 * 读不出来(加密不可用 / IO 抖动 / 解密失败)时一律不删:宁可留一枚已失效的
 * token(下次 refresh 自然会再判一次),也不能误删有效凭证。
 *
 * 内容比对之外再校验一次文件身份(inode / mtime / size),把「读到的是旧值、删掉的
 * 却是刚写入的新文件」这段 TOCTOU 收紧到两次 stat 之间。
 *
 * **这不是真正原子的 compare-and-delete**:POSIX 没有按路径的 CAS unlink,而本模块
 * 的写入侧(writeSafe 直接 writeFileSync 覆盖)同样不原子。要彻底消除竞态,得把整个
 * safeStorage 层改成「临时文件 + rename 写入 + 跨进程锁」,那是独立重构,不在本次
 * 范围内。当前收益是把窗口从数秒级压到一次 syscall,且真正高频的那条路径
 * (passive)已经完全不删。
 */
type RemoveIfUnchangedResult =
  /** 确实删掉了(或删除时文件已不在,目标状态达成)。 */
  | 'deleted'
  /** 磁盘上的已经不是本次判定的那一枚,按约定不删。 */
  | 'changed'
  /** 删除真的失败了(权限 / IO):凭证还在盘上,调用方不得当成已清理。 */
  | 'failed';

function removeSafeIfUnchanged(key: string, expected: string): RemoveIfUnchangedResult {
  const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
  // 三态:拿到身份 / 文件确定不在(ENOENT) / stat 本身失败。后两者必须分开——
  // 「已经不在」是目标状态达成,「读不到状态」是我们不敢动它。
  type Identity = { kind: 'ok'; id: string } | { kind: 'absent' } | { kind: 'error' };
  const identity = (): Identity => {
    try {
      const s = fs.statSync(filepath);
      return { kind: 'ok', id: `${s.ino}:${s.mtimeMs}:${s.size}` };
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? { kind: 'absent' }
        : { kind: 'error' };
    }
  };
  const before = identity();
  if (before.kind === 'absent') return 'deleted';
  if (before.kind === 'error') return 'failed';
  if (readSafe(key) !== expected) return 'changed';
  // 读内容期间文件被换掉(另一个实例写入了替换凭证)→ 那枚不在本次判定范围内。
  const after = identity();
  if (after.kind === 'absent') return 'deleted';
  if (after.kind === 'error') return 'failed';
  if (after.id !== before.id) return 'changed';
  try {
    // 不走 removeSafe():它吞掉所有 unlink 错误,会让调用方把「没删成」当成
    // 「已清理」并据此打日志。这里必须如实区分。
    fs.unlinkSync(filepath);
    return 'deleted';
  } catch (err) {
    // 这一瞬别人已经删掉了 → 目标状态达成,算成功。
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'deleted';
    // EPERM / EACCES / EBUSY 等:凭证仍在盘上。与读写路径同一 helper——只记
    // code/name,fs 错误的 message 携带 userData 绝对路径,不进长期日志。
    logSafeStorageIssueOnce('delete failed', key, err);
    return 'failed';
  }
}

// ── PKCE (Node.js native crypto) ────────────────────────────────────────────

// ── net.fetch helper ────────────────────────────────────────────────────────

/**
 * Per-request timeout for auth API calls (ms). Prevents net.fetch from hanging
 * indefinitely on black-hole / captive-portal networks. Pass `timeoutMs: 0` to
 * disable (required for token-rotating endpoints where aborting mid-flight can
 * cause permanent logout).
 */
const API_FETCH_TIMEOUT_MS = 15_000;

async function apiFetch<T>(
  apiPath: string,
  options?: {
    method?: string;
    body?: unknown;
    token?: string | null;
    timeoutMs?: number;
    baseUrl?: string;
  },
): Promise<{ ok: boolean; status: number; data: T; retryAt?: number }> {
  const url = (options?.baseUrl ?? authServerUrl()) + apiPath;
  const method = options?.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) {
    headers['Authorization'] = 'Bearer ' + options.token;
  }
  const effectiveTimeout = options?.timeoutMs ?? API_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer =
    effectiveTimeout > 0 ? setTimeout(() => controller.abort(), effectiveTimeout) : undefined;
  try {
    const response = await net.fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: effectiveTimeout > 0 ? controller.signal : undefined,
    });
    const retryAt =
      response.status === 429 || response.status === 503 ? retryAfterDeadline(response) : undefined;
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (error) {
      log.warn(
        'auth response read failed',
        apiPath,
        { status: response.status },
        requestErrorMessage(error),
      );
      return { ok: false, status: response.status, data: null as T, retryAt };
    }
    const errorCode = (data as AuthErrorResponse | null)?.error?.code;
    if (response.status === 401 && errorCode === 'ACCOUNT_UNAVAILABLE' && currentUser) {
      // Internal auth-server calls (profile/feature flags/refresh) do not pass
      // through serverApiClient, but share the same terminal auth contract.
      void invalidateSession('account-unavailable');
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      ...(retryAt !== undefined ? { retryAt } : {}),
    };
  } catch (error) {
    log.warn('auth request failed', apiPath, requestErrorMessage(error));
    return { ok: false, status: 0, data: null as T };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requestAuthRefresh(
  refreshToken: string,
  realm = activeAuthRealm,
): Promise<AuthRefreshResult> {
  // refresh 是 token-rotating 端点,禁用 abort timeout——若服务端已轮换但
  // 客户端 abort,重试旧 token 会触发 INVALID_REFRESH_TOKEN。
  return apiFetch<RefreshResponse | AuthErrorResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken, deviceId },
    timeoutMs: 0,
    baseUrl: authServerUrl(realm),
  });
}

function getRefreshErrorCode(result: { data: unknown }): string | undefined {
  return (result.data as AuthErrorResponse | null)?.error?.code;
}

function mapMembershipToAuthUser(membership: AuthMembership, passportId?: string): CurrentUser {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    membershipDisplayName: membership.displayName,
    // auth-server 自助头像(PATCH /api/me/profile);null = 未设置(UI 首字母兜底)。
    // 产品资料头像回落已随 /api/user/me 退役(2026-07)。
    avatar: membership.avatarUrl ?? null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
    // membership 响应不带 slug;所有出口经 snapshotAuthState 时从 access token 补齐。
    orgSlug: null,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

function mergeMembershipWithExisting(
  membership: AuthMembership,
  existing: CurrentUser | null,
): CurrentUser {
  const mapped = mapMembershipToAuthUser(membership);
  if (!existing || existing.id !== mapped.id) return mapped;
  return {
    ...mapped,
    // membership 自助头像优先;未设置时保留既有展示值。
    avatar: mapped.avatar ?? existing.avatar,
    defaultModel: existing.defaultModel,
    defaultEffort: existing.defaultEffort,
    passportId: mapped.passportId || existing.passportId,
  };
}

/** Serialize a verified cloud owner commit with the shared Ghost projection. */
async function withCloudOwnerCommit<T>(opts: {
  previousOwnerId: string | null;
  nextOwnerId: string;
  prepareTransition: () => Promise<void>;
  prepareCommit?: () => Promise<void>;
  commit: () => T | Promise<T>;
}): Promise<T> {
  if (isPassiveSharedUserDataInstance()) {
    return withGhostSkillProjectionReadOnlyOwner(opts.nextOwnerId, opts.commit);
  }
  let releaseBoundary: (() => void) | null = null;
  let heldOwnerChangeShell = false;
  // A same-owner projection repair tears down the owner-bound Ghost runtime but
  // keeps the same mode/owner, so commitActiveAppSession's same-owner early
  // return would NOT advance the owner generation — stale async work that
  // captured the pre-repair scope key would then pass the post-release guard.
  // Force a generation bump so the scope key changes across the teardown.
  let forceBumpGeneration = false;
  let result!: T;
  let committed = false;
  let commitApplied = false;
  let rollbackReservation: CloudOwnerDataReservation | null = null;
  try {
    result = await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: opts.previousOwnerId,
      nextOwnerId: opts.nextOwnerId,
      prepareTransition: async ({ ownerChanged }) => {
        // Same-owner Ghost repair (token refresh when the durable projection is
        // unstable) is not a logout. Broadcasting snapshotLoggedOutAuthState()
        // here bounced ProtectedRoute to /login every ~55 minutes.
        if (ownerChanged) {
          notifyRendererAuthBoundaryPending();
          enterOwnerChangeShellPending();
          heldOwnerChangeShell = true;
        }
        releaseBoundary = beginAppSessionBoundary();
        if (ownerChanged) {
          await opts.prepareTransition();
        } else {
          if (!projectionRepairTeardown) {
            throw new Error('Ghost projection repair requires a teardown hook');
          }
          forceBumpGeneration = true;
          await projectionRepairTeardown('same-owner-projection-recovery');
        }
      },
      prepareCommit: async () => {
        rollbackReservation = reserveCloudOwnerData(opts.nextOwnerId, opts.previousOwnerId);
        await opts.prepareCommit?.();
      },
      commit: async () => {
        const result = await opts.commit();
        commitApplied = true;
        const reservation = rollbackReservation as CloudOwnerDataReservation | null;
        if (reservation && !reservation.finalize()) {
          throw new Error('cloud owner data reservation finalization remains pending');
        }
        rollbackReservation = null;
        // Same-owner repair: advance the owner generation after the real commit
        // so activeOwnerScopeKey() changes and stale captured scopes are rejected.
        if (forceBumpGeneration) {
          const session = getActiveAppSession();
          commitActiveAppSession(session.mode, session.dataOwnerId ?? undefined, true);
        }
        return result;
      },
      onCommitFailure: ({ commitApplied: boundaryCommitApplied }) => {
        // The cloud session/token commit is already durable at this point. A
        // later projection-state publication failure must keep the first-owner
        // reservations so another account cannot inherit the same local data.
        if (boundaryCommitApplied || commitApplied) return;
        const reservation = rollbackReservation as CloudOwnerDataReservation | null;
        if (!reservation) return;
        if (!reservation.rollback()) {
          throw new Error('cloud owner data reservation rollback remains pending');
        }
        rollbackReservation = null;
      },
    });
    committed = true;
  } finally {
    if (!committed && !commitApplied) {
      const reservation = rollbackReservation as CloudOwnerDataReservation | null;
      if (reservation?.rollback()) rollbackReservation = null;
    }
    const release = releaseBoundary as (() => void) | null;
    release?.();
    if (heldOwnerChangeShell) leaveOwnerChangeShellPending();
    if (release) notifyRenderer();
  }
  if (committed) requestStableOwnerPostCommit('owner-commit');
  return result;
}

/**
 * Publish an account-free owner only after the same global Ghost projection
 * transition used by cloud login and account replacement has completed.
 *
 * The auth fields are cleared in the commit callback, after the durable
 * pending marker and teardown. If the transition cannot be persisted or the
 * sweep fails, the local session is still made account-free, but the durable
 * boundary remains non-stable so a later cloud owner cannot commit without a
 * fresh sweep.
 */
async function withAccountFreeOwnerCommit(opts: {
  reason: string;
  nextMode: Extract<AppSessionMode, 'signed-out' | 'local'>;
  credentialStoreUnavailable?: boolean;
  preservePersistedRefreshToken?: boolean;
  notify?: boolean;
  clearOnFailure?: boolean;
  authAlreadyCleared?: boolean;
  validateBeforeCommit?: () => boolean;
  shouldClearOnFailure?: () => boolean;
  /** 本次收敛是冷启动启动闸超时兜底;转发给 clearAuth 以便同步登记兜底代际。 */
  coldStartTimeoutRecovery?: boolean;
}): Promise<void> {
  let authCleared = opts.authAlreadyCleared ?? false;
  let releaseBoundary: (() => void) | null = null;
  let heldOwnerChangeShell = false;
  // Same-owner account-free repair tears down the owner-bound Ghost runtime but
  // keeps the same mode/owner, so commitActiveAppSession's same-owner early
  // return would NOT advance the owner generation — stale async work that
  // captured the pre-repair scope key would then pass the post-release guard.
  let forceBumpGeneration = false;
  const notify = opts.notify ?? true;
  const previousOwnerId = getActiveAppSession().dataOwnerId;
  if (isPassiveSharedUserDataInstance()) {
    if (opts.validateBeforeCommit && !opts.validateBeforeCommit()) {
      throw new AuthApiError(
        'AUTH_FLOW_SUPERSEDED',
        409,
        'Account-free owner transition was superseded before commit',
      );
    }
    if (!authCleared) {
      clearAuth({
        notify: false,
        nextMode: opts.nextMode,
        preservePersistedRefreshToken: true,
        credentialStoreUnavailable: opts.credentialStoreUnavailable,
        deferSessionCommit: true,
        coldStartTimeoutRecovery: opts.coldStartTimeoutRecovery,
      });
      authCleared = true;
    }
    commitVolatileAppSession(opts.nextMode);
    if (notify) {
      notifyRenderer();
      notifyAuthListeners();
    }
    return;
  }
  try {
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId,
      nextOwnerId: opts.nextMode === 'local' ? accountFreeDataOwnerId() : null,
      prepareTransition: async ({ ownerChanged }) => {
        notifyRendererAuthBoundaryPending();
        enterOwnerChangeShellPending();
        heldOwnerChangeShell = true;
        releaseBoundary = beginAppSessionBoundary();
        if (ownerChanged) {
          if (!authSessionTeardown) {
            throw new Error('account-free owner transition requires a teardown hook');
          }
          await authSessionTeardown(opts.reason);
        } else {
          if (!projectionRepairTeardown) {
            throw new Error('account-free projection repair requires a teardown hook');
          }
          forceBumpGeneration = true;
          await projectionRepairTeardown(opts.reason);
        }
      },
      prepareCommit: async () => {
        if (opts.validateBeforeCommit && !opts.validateBeforeCommit()) {
          throw new AuthApiError(
            'AUTH_FLOW_SUPERSEDED',
            409,
            'Account-free owner transition was superseded before commit',
          );
        }
      },
      commit: () => {
        if (!authCleared) {
          clearAuth({
            notify: false,
            nextMode: opts.nextMode,
            preservePersistedRefreshToken: opts.preservePersistedRefreshToken,
            credentialStoreUnavailable: opts.credentialStoreUnavailable,
            deferSessionCommit: true,
            coldStartTimeoutRecovery: opts.coldStartTimeoutRecovery,
          });
          authCleared = true;
        }
        commitActiveAppSession(opts.nextMode);
        // Same-owner account-free repair: advance the owner generation after the
        // real commit so activeOwnerScopeKey() changes and stale captured scopes
        // are rejected across the teardown.
        if (forceBumpGeneration) {
          commitActiveAppSession(opts.nextMode, undefined, true);
        }
      },
    });
  } catch (error) {
    // A terminal auth path must not leave an in-memory cloud owner active. The
    // durable state is intentionally left missing/pending so future cloud
    // publication remains fail-closed until another full transition succeeds.
    if (opts.clearOnFailure && (opts.shouldClearOnFailure?.() ?? true)) {
      if (!authCleared) {
        clearAuth({
          notify: false,
          nextMode: 'signed-out',
          preservePersistedRefreshToken: opts.preservePersistedRefreshToken,
          credentialStoreUnavailable: opts.credentialStoreUnavailable,
          deferSessionCommit: true,
          coldStartTimeoutRecovery: opts.coldStartTimeoutRecovery,
        });
        authCleared = true;
      }
      // The durable app-session write may be the operation that failed. Keep
      // the process account-free without retrying that write on this path.
      try {
        commitVolatileAppSession('signed-out');
      } catch (sessionError) {
        log.error('failed to commit volatile signed-out fallback', sessionError);
      }
    }
    throw error;
  } finally {
    const release = releaseBoundary as (() => void) | null;
    release?.();
    if (heldOwnerChangeShell) leaveOwnerChangeShellPending();
    if (release && notify) notifyRenderer();
  }

  requestStableOwnerPostCommit('owner-commit');
  if (notify) {
    notifyRenderer();
    notifyAuthListeners();
  }
}

async function recoverAccountFreeOwnerAtStartup(
  mode: Extract<AppSessionMode, 'signed-out' | 'local'>,
  reason: string,
  credentialStoreUnavailable = false,
  /**
   * 本次收敛是冷启动启动闸超时兜底。必须由调用方显式声明并透传到 clearAuth:
   * 兜底代际要在推进代际的同一同步时刻登记,不能等本函数返回(PR #6273 review P1)。
   */
  opts: { coldStartTimeoutRecovery?: boolean } = {},
): Promise<void> {
  const ownerId = mode === 'local' ? accountFreeDataOwnerId() : null;
  // An adopted former cloud owner replaces the initial local-v1 projection;
  // that owner change always takes the full teardown boundary below.
  const adoptedOwnerPending = mode === 'local' && getActiveAppSession().dataOwnerId !== ownerId;
  if (!adoptedOwnerPending && isGhostSkillProjectionBoundaryStableForOwner(ownerId)) {
    if (credentialStoreUnavailable) credentialStoreHealth.noteStartupFailure();
    if (getActiveAppSession().mode !== mode || getActiveAppSession().dataOwnerId !== ownerId) {
      if (isPassiveSharedUserDataInstance()) {
        commitVolatileAppSession(mode);
      } else {
        commitActiveAppSession(mode);
      }
    }
    requestStableOwnerPostCommit('owner-already-stable');
    return;
  }
  await withAccountFreeOwnerCommit({
    reason,
    nextMode: mode,
    credentialStoreUnavailable,
    notify: false,
    clearOnFailure: mode === 'signed-out',
    preservePersistedRefreshToken: true,
    coldStartTimeoutRecovery: opts.coldStartTimeoutRecovery,
  });
}

interface CloudOwnerDataReservation {
  rollback(): boolean;
  finalize(): boolean;
}

function recoverCloudOwnerDataReservations(committedOwnerId: string | null): boolean {
  const profileRecovery = recoverPendingLocalProfileDataOwner(
    committedOwnerId,
    app.getPath('userData'),
    BRAND_IDENTITY.dbFilePrefix,
  );
  const nativeRecovery = recoverPendingLegacyNativeProviderAuthOwner(committedOwnerId);
  return profileRecovery !== 'failed' && nativeRecovery !== 'failed';
}

function resolveProfileReservationOwnerId(ownerId: string): string {
  const nativeOwner = readLegacyNativeProviderAuthOwner();
  if (nativeOwner.status === 'failed') {
    throw new Error('native provider ownership could not be read before profile reservation');
  }
  return nativeOwner.status === 'owned' ? nativeOwner.ownerId : ownerId;
}

function reserveCloudOwnerData(
  ownerId: string,
  previousOwnerId: string | null,
): CloudOwnerDataReservation {
  const rollbackActions: Array<() => void> = [];
  try {
    if (!recoverCloudOwnerDataReservations(previousOwnerId)) {
      throw new Error('pending cloud owner data reservation recovery failed');
    }
    // Older builds could durably assign only the native-provider namespace.
    // Preserve that first owner when introducing the profile marker: a
    // different currently persisted account may authenticate, but must not
    // reinterpret the still-shared local database as its own.
    const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);
    const profileReservation = reserveLocalProfileDataOwnerDetailed(
      profileReservationOwnerId,
      app.getPath('userData'),
      BRAND_IDENTITY.dbFilePrefix,
    );
    if (profileReservation.status === 'failed') {
      throw new Error('local profile data reservation failed before cloud owner commit');
    }
    if (profileReservation.status === 'claimed' && profileReservation.claimToken) {
      rollbackActions.push(() => {
        releaseLocalProfileDataOwner(
          profileReservationOwnerId,
          app.getPath('userData'),
          BRAND_IDENTITY.dbFilePrefix,
          profileReservation.claimToken!,
        );
      });
    }

    const authoritativeOwnerId = profileReservation.ownerId;
    if (!authoritativeOwnerId) {
      throw new Error('local profile data reservation did not identify its durable owner');
    }
    // Keep this reservation provisional until the same cloud commit finalizes
    // both namespaces. Even when the profile marker was already durable, a
    // missing native marker must remain rollback-able if this auth transition
    // is superseded before commit.
    const nativeReservation = reserveLegacyNativeProviderAuthOwnerDetailed(authoritativeOwnerId);
    if (nativeReservation.status === 'failed') {
      throw new Error('native provider ownership reservation failed before cloud owner commit');
    }
    if (nativeReservation.status === 'owned-by-other') {
      throw new Error('local profile and native provider ownership reservations disagree');
    }
    if (nativeReservation.status === 'claimed' && nativeReservation.claimToken) {
      rollbackActions.push(() => {
        releaseLegacyNativeProviderAuthOwner(authoritativeOwnerId, nativeReservation.claimToken!);
      });
    }
    if (authoritativeOwnerId !== ownerId) {
      log.info('cloud owner committed without adopting legacy local data', {
        ownerId,
        authoritativeOwnerId,
        profileReservation: profileReservation.status,
        nativeReservation: nativeReservation.status,
      });
    }
    return {
      rollback: () => {
        for (const rollback of rollbackActions.reverse()) rollback();
        return recoverCloudOwnerDataReservations(previousOwnerId);
      },
      finalize: () => recoverCloudOwnerDataReservations(authoritativeOwnerId),
    };
  } catch (error) {
    for (const rollback of rollbackActions.reverse()) rollback();
    throw error;
  }
}

function repairStableCloudOwnerDataReservationsWhileLocked(ownerId: string): boolean {
  let profileReservation: ReturnType<typeof reserveCommittedLocalProfileDataOwnerDetailed> = {
    status: 'failed',
  };
  let nativeReservation: ReturnType<typeof reserveCommittedLegacyNativeProviderAuthOwner> =
    'failed';

  if (!recoverCloudOwnerDataReservations(ownerId)) {
    log.error('stable cloud owner reservation recovery failed', { ownerId });
    return false;
  }
  try {
    const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);
    profileReservation = reserveCommittedLocalProfileDataOwnerDetailed(
      profileReservationOwnerId,
      app.getPath('userData'),
      BRAND_IDENTITY.dbFilePrefix,
    );
  } catch (error) {
    log.warn('stable cloud owner local profile reservation repair failed', {
      ownerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (profileReservation.status === 'failed' || !profileReservation.ownerId) {
    log.warn('stable cloud owner remains authenticated with local adoption fail-closed', {
      ownerId,
      profileReservation: profileReservation.status,
      nativeReservation,
    });
    return false;
  }
  const authoritativeOwnerId = profileReservation.ownerId;
  try {
    nativeReservation = reserveCommittedLegacyNativeProviderAuthOwner(authoritativeOwnerId);
  } catch (error) {
    log.warn('stable cloud owner native provider reservation repair failed', {
      ownerId,
      authoritativeOwnerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (nativeReservation === 'failed' || nativeReservation === 'owned-by-other') {
    log.warn('stable cloud owner remains authenticated with local adoption fail-closed', {
      ownerId,
      authoritativeOwnerId,
      profileReservation: profileReservation.status,
      nativeReservation,
    });
    return false;
  }
  return authoritativeOwnerId === ownerId;
}

async function repairStableCloudOwnerDataReservations(ownerId: string): Promise<boolean> {
  try {
    // Cloud commits already hold this cross-process owner lock from reservation
    // through finalize/rollback. Stable-owner repair must join the same lock so
    // it cannot settle one namespace while a concurrent login settles the other.
    return await withStableOwnerBoundaryMutation(ownerId, async () =>
      repairStableCloudOwnerDataReservationsWhileLocked(ownerId),
    );
  } catch (error) {
    log.warn('stable cloud owner reservation repair could not enter owner transaction', {
      ownerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function commitCloudAppSession(ownerId: string, authRealmChanged = false): void {
  // Saved identities are [realm, membershipId]. Same-id realm moves must fence old API work too.
  if (isPassiveSharedUserDataInstance()) {
    commitVolatileAppSession('cloud', ownerId, authRealmChanged);
  } else {
    commitActiveAppSession('cloud', ownerId, authRealmChanged);
  }
  // Publish the new generation in the same synchronous commit as the token
  // and endpoint switch, before any post-commit migration/projection await.
  // Same-id realm moves do not necessarily enter a Ghost owner boundary.
  if (authRealmChanged) notifyRenderer();
}

/**
 * Complete the one-way local → cloud native-provider ownership handoff after
 * the durable owner boundary is stable. The binding layer keeps this
 * fail-closed for other cloud owners and corrupted state.
 */
async function migrateLocalProviderBindingsAfterCloudCommit(ownerId: string): Promise<void> {
  if (isPassiveSharedUserDataInstance()) return;
  try {
    // The profile marker is the single durable authority for both retained
    // local namespaces. Reconcile the native marker to that owner before any
    // legacy credential migration can run.
    if (!(await repairStableCloudOwnerDataReservations(ownerId))) return;
    if (migrateLocalNativeProviderAuthBindings(ownerId)) {
      log.info('migrated local native provider bindings to first cloud owner', { ownerId });
    }
  } catch (error) {
    log.warn('local native provider binding migration failed', {
      ownerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finishColdStartSignedOut(
  reason: string,
  credentialStoreUnavailable = false,
): Promise<AuthState> {
  await recoverAccountFreeOwnerAtStartup('signed-out', reason, credentialStoreUnavailable);
  return snapshotLoggedOutAuthState();
}

export function setAccountSwitchTeardown(teardown: AccountSwitchTeardown | null): void {
  accountSwitchTeardown = teardown;
}

export function setAuthSessionTeardown(teardown: AuthSessionTeardown | null): void {
  authSessionTeardown = teardown;
}

export function setProjectionRepairTeardown(teardown: ProjectionRepairTeardown | null): void {
  projectionRepairTeardown = teardown;
}

/** Register the owner-scoped work that must settle after the durable boundary is stable. */
export function setStableOwnerPostCommitTask(task: StableOwnerPostCommitTask | null): void {
  stableOwnerPostCommitCoordinator.setTask(task);
}

// ── User-level API key sync ─────────────────────────────────────────────────
//
// 已移除。XD 网关 key / Mivo key 均为 **本地 only**(Electron safeStorage),
// 从不同步到服务器,因此登录 / 冷启动不再从服务器拉 key 写本地。新设备 / 新登录
// 需用户在本机重新填入 key。renderer 侧 useApiKey / useMivoApiKey 同为本地 only。

// ── Refresh scheduling ──────────────────────────────────────────────────────

function scheduleRefresh(token: string): void {
  refreshBackoff.clear();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // 续期节奏对 passive 实例不设闸门。本 PR 的契约是「passive 不写/不删共享的
  // auth 持久状态」;「谁负责续期」是正交问题,不在这里解决。让 passive 停止续期
  // 会让它的 access token 过期后再无替换途径(primary 的续期只更新磁盘 token,
  // 不更新本进程内存态),而 updateServerProfile 等直接走 apiFetch 的路径没有
  // 401 refresh/retry,会一直失败到进程重启——resume 也救不了,系统不休眠就不触发。
  // 轮换本身不会踢人:2026-07-27 两个实例每 55 分钟互刷一次,primary 每次都靠
  // replacement-retry 恢复,一次没掉线;把 primary 踢下线的是删除凭证。
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
    const delay = (payload.exp - 300) * 1000 - Date.now();
    if (delay <= 0) {
      refresh();
    } else {
      refreshTimer = setTimeout(() => refresh(), delay);
    }
  } catch {
    // Invalid JWT format — skip scheduling
  }
}

/**
 * 运行时 refresh 瞬时失败后的补救重排。
 *
 * 正常路径的 refreshTimer 在触发时即消耗;若这次 refresh 因网络抖动 / 429 / 5xx 失败,
 * 不重排的话就再没有下一次尝试,access token 会在几分钟后静默过期(下一次自愈要等
 * 系统 resume 或冷启动)。失败采用带随机抖动的指数退避,避免全体客户端集中重试;
 * 确定性凭据失效不走这里(直接 clearAuth + 弹重登)。
 */
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250] as const;
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000] as const;
const REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

// 运行时 replacement refresh 成功后,会先持久化新 refresh token 再做 /me 身份核对。
// 如果 /me 或账号切换 teardown 瞬时失败,下一轮 refresh 读到的 token 已不再表现为
// replacementRetries > 0;用这个进程内标记强制下一轮继续 /me,避免 accessToken 切到 B
// 但 currentUser/renderer 仍停在 A。
let persistedRefreshTokenNeedsIdentityCheck = false;
// 当前进程最后一次接受/写入的 refresh token。运行时 refresh 开始前如果磁盘 token
// 已经被另一个共享 userData 实例换掉,即使本轮没有走 replacement-retry,也必须 /me
// 核对身份,避免 currentUser 仍是 A 但 accessToken 已切到 B。
let lastAcceptedRefreshToken: string | null = null;
let replacementIntegrationReloadTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * 冷启动 auth 流程最多阻塞 splash 的时长。refresh 是 token-rotating 端点,禁止
 * per-request abort(见 requestAuthRefresh),黑洞 / captive-portal 网络下请求会
 * 无限挂起——没有这道闸,initialize() 永不 resolve,splash 永不淡出。超时后先以
 * 未登录返回解锁 UI,流程继续后台跑:迟到成功会正常广播登录态,renderer 的
 * GuestRoute 自动把用户从登录页带回主界面。网络失败后的分钟级持续重试不阻塞 splash。
 */
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20_000;

/**
 * auth 状态代际计数:login / clearAuth(logout、会话过期、账号切换)
 * 每次改写全局登录态时 +1。冷启动流程在开跑时快照代际,超时转后台后的每个状态
 * 写入点都先核对代际——用户在流程挂起期间手动登录 / 登出过,则迟到结果整体丢弃,
 * 绝不覆盖更新的登录态或删除新写入的 refresh token。
 */
let authStateEpoch = 0;

/**
 * 启动闸超时兜底(`cold-start-timeout-recovery`)自己造成的代际推进:从 `from`
 * 推到 `to`,在 clearAuth 推进代际的**同一同步时刻**记录。
 *
 * 记成一对(而不是只记新代际)才能把豁免绑定到「这次兜底」:冷启动流程只在自己
 * 当前代际等于 `from` 且现值为 `to` 时被豁免。若用户在该兜底之前已经显式登录过,
 * 兜底的 `from` 就不等于流程起始代际,旧流程仍被正常作废(不会反过来覆盖新登录)。
 * 见 authStartupGate 的 ColdStartAuthFallbackRegistry。
 */
const coldStartTimeoutFallbacks = new ColdStartAuthFallbackRegistry();

/**
 * 登录态落地后异步同步灰度标记，不阻塞 renderer 进入主界面。
 *
 * expectedAuthEpoch + expectedUserId 防止慢响应在登出或换账号之后覆盖新身份；
 * 请求失败/响应非法则保留旧值，遵守 feature-flags 服务端契约。
 */
function scheduleCanaryFlagSync(input: {
  token: string;
  expectedAuthEpoch: number;
  expectedUserId: string;
}): void {
  void syncCanaryFlagAfterAuth(input, {
    fetchFeatureFlags: (token) =>
      apiFetch('/api/user/feature-flags', {
        token,
        baseUrl: getClientEndpoint('oauthBrokerApiBaseUrl'),
      }),
    readCurrentAuthIdentity: () => ({
      authEpoch: authStateEpoch,
      userId: currentUser?.id ?? null,
    }),
    persistFlag: canaryFlagStore.sync,
  })
    .then((outcome) => {
      scheduleNonXdOrgBetaDefault({
        expectedAuthEpoch: input.expectedAuthEpoch,
        expectedUserId: input.expectedUserId,
        defaultEnableBeta: outcome.defaultEnableBeta,
      });
      if (outcome.kind === 'synced') {
        log.info('canary feature flag synced: isCanary=%s', outcome.isCanary);
        // feature-flags 在登录态落地后异步返回；立即推送新快照，让 renderer
        // 的 Canary 装饰不必等到下一次 refresh / 重启才更新。
        notifyRenderer();
        return;
      }
      if (outcome.reason === 'stale-auth') {
        log.debug('discarded stale canary feature-flags response');
        return;
      }
      log.warn(
        'canary feature flag sync preserved local value: reason=%s status=%s',
        outcome.reason,
        outcome.status ?? '<none>',
      );
    })
    .catch((err) => {
      // persistFlag currently absorbs filesystem errors, but keep this boundary
      // non-fatal if that implementation changes later.
      log.error('canary feature flag sync threw unexpectedly', err);
    });
}

/**
 * 登录态落地后为 xd 组织补一次设备级 beta 默认值,不阻塞进主界面。
 *
 * expectedAuthEpoch + expectedUserId 防止探测完成时已经登出 / 换号。
 * 用户手动关过(isCustomized)后不再打开;probe 失败也不写盘,下次登录再试。
 */
function scheduleXdOrgBetaDefault(input: {
  expectedAuthEpoch: number;
  expectedUserId: string;
}): void {
  if (isPassiveSharedUserDataInstance()) return;
  const user = currentUser;
  if (!user) return;
  void maybeEnableXdOrgBetaDefault(
    {
      expectedAuthEpoch: input.expectedAuthEpoch,
      expectedUserId: input.expectedUserId,
      user: {
        membershipKind: user.membershipKind,
        orgName: user.orgName,
        orgSlug: decodeAccessTokenOrgSlug(accessToken),
      },
    },
    {
      readCurrentAuthIdentity: () => ({
        authEpoch: authStateEpoch,
        userId: currentUser?.id ?? null,
      }),
      readChannelState: () => ({
        enableBeta: readUpdateChannelSettings().enableBeta,
        isCustomized: isEnableBetaUserCustomized(),
      }),
      probeBetaManifest,
      enableBeta: () =>
        enableUncustomizedBetaChannel(
          () =>
            authStateEpoch === input.expectedAuthEpoch && currentUser?.id === input.expectedUserId,
        ),
    },
  )
    .then((outcome) => {
      if (outcome.kind === 'enabled') {
        log.info('xd org beta channel default enabled');
        return;
      }
      if (outcome.reason === 'stale-auth') {
        log.debug('discarded stale xd org beta default');
        return;
      }
      log.debug('xd org beta channel default skipped: reason=%s', outcome.reason);
    })
    .catch((err) => {
      log.error('xd org beta channel default threw unexpectedly', err);
    });
}

/** feature-flags 返回后，仅为非 xd 组织补一次设备级 beta 默认值。 */
function scheduleNonXdOrgBetaDefault(input: {
  expectedAuthEpoch: number;
  expectedUserId: string;
  defaultEnableBeta?: boolean;
}): void {
  if (isPassiveSharedUserDataInstance()) return;
  const user = currentUser;
  if (!user) return;
  const request = {
    expectedAuthEpoch: input.expectedAuthEpoch,
    expectedUserId: input.expectedUserId,
    user: {
      membershipKind: user.membershipKind,
      orgName: user.orgName,
      orgSlug: decodeAccessTokenOrgSlug(accessToken),
    },
  } as const;
  if (
    shouldAttemptOrgBetaDefault({
      user: request.user,
      defaultEnableBeta: input.defaultEnableBeta,
    }) !== 'flag-enable'
  ) {
    return;
  }
  void maybeEnableNonXdOrgBetaDefault(request, {
    readCurrentAuthIdentity: () => ({
      authEpoch: authStateEpoch,
      userId: currentUser?.id ?? null,
    }),
    readChannelState: () => ({
      enableBeta: readUpdateChannelSettings().enableBeta,
      isCustomized: isEnableBetaUserCustomized(),
    }),
    probeBetaManifest,
    enableBeta: () =>
      enableUncustomizedBetaChannel(
        () =>
          authStateEpoch === input.expectedAuthEpoch && currentUser?.id === input.expectedUserId,
      ),
  })
    .then((outcome) => {
      if (outcome.kind === 'enabled') log.info('feature-flag beta channel default enabled');
      else if (outcome.reason === 'stale-auth') log.debug('discarded stale non-xd beta default');
      else log.debug('non-xd beta channel default skipped: reason=%s', outcome.reason);
    })
    .catch((err) => log.error('non-xd beta channel default threw unexpectedly', err));
}

/**
 * 冷启动流程的进程内去重:主窗超时转后台之后,副窗 / 右侧栏窗口 mount 再调
 * initialize() 时复用同一个 in-flight promise(各自套各自的超时),避免两条流程
 * 并发轮换同一枚 refresh token 互相打成 INVALID_REFRESH_TOKEN。
 */
let coldStartAuthInFlight: Promise<AuthState> | null = null;
// A newly mounted window must not restart recovery after the user took over.
let coldStartRecoveryStopped = false;
// The saved credential owns the deadline, not the login page/recovery invocation.
// Returning to the page must keep both Retry-After and its random spread.
type ColdStartRetryState = {
  refreshToken: string;
  realm: AuthRegion;
  backoff: AuthRefreshBackoff;
  failure?: AuthRefreshResult;
};
let coldStartRetryState: ColdStartRetryState | null = null;

// Wakes only the delay between attempts, never aborts a rotating refresh request.
let coldStartRetryWait: ((cancel?: boolean) => void) | null = null;

function waitForColdStartRetry(retry: ColdStartRetryState): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      if (coldStartRetryWait === wake) coldStartRetryWait = null;
      resolve();
    };
    const wake = (cancel = false) => {
      if (cancel || retry.backoff.remaining(0) === 0) finish();
    };
    const tick = () => {
      const remaining = retry.backoff.remaining(0);
      if (remaining <= 0) finish();
      else {
        timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
        timer.unref?.();
      }
    };
    coldStartRetryWait = wake;
    tick();
  });
}

function stopColdStartRecovery(): void {
  coldStartRecoveryStopped = true;
  // Pause publication/retries without poisoning an in-flight rotation. A reset
  // can resume that same request; actual login/logout still advance auth epochs.
  coldStartRetryWait?.(true);
}

function scheduleRefreshRetryAfterTransientFailure(
  epoch: number,
  retryAt?: number,
  networkFailure = false,
): void {
  if (epoch !== authStateEpoch) return;
  refreshBackoff.defer(epoch, retryAt, networkFailure);
  scheduleRefreshRetry(epoch);
}

function scheduleRefreshRetry(epoch: number): void {
  const delay = refreshBackoff.runtimeRemaining(epoch);
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // A long server deadline must not overflow Node's timer into an immediate
  // retry; re-arm it in bounded chunks without extending the original wait.
  const retry = () => {
    if (authStateEpoch !== epoch) return;
    const remaining = refreshBackoff.runtimeRemaining(epoch);
    if (remaining > 0) refreshTimer = setTimeout(retry, Math.min(remaining, 2_147_483_647));
    else {
      refreshTimer = null;
      void refresh();
    }
  };
  refreshTimer = setTimeout(retry, Math.min(delay, 2_147_483_647));
}

function clearReplacementIntegrationReloadTimers(): void {
  for (const timer of replacementIntegrationReloadTimers) {
    clearTimeout(timer);
  }
  replacementIntegrationReloadTimers = [];
}

async function runAuthRefreshWithReplacementRetry(
  initialRefreshToken: string,
  opts: {
    phase: 'cold-start' | 'runtime';
    realm: AuthRegion;
    withTransientRetry: boolean;
    rateLimitDelayMs?: number;
    onFailure?: (info: RefreshFailureInfo) => void;
  },
): Promise<{
  result: AuthRefreshResult;
  attempts: number;
  requestedToken: string;
  replacementRetries: number;
  replacementRetryExhausted: boolean;
  failureAction?: RefreshFailureAction;
  rejectedTokens: readonly string[];
}> {
  const run = await runRefreshWithReplacementRetry(initialRefreshToken, {
    doRefresh: (refreshToken) => requestAuthRefresh(refreshToken, opts.realm),
    readLatestStoredTokens: () => readStoredRefreshTokenCandidates(opts.realm),
    transientRetry: opts.withTransientRetry
      ? {
          rateLimitDelayMs: opts.rateLimitDelayMs,
          onFailure: opts.onFailure,
        }
      : undefined,
    maxReplacementRetries: REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT,
    replacementRecheck: {
      delaysMs:
        opts.phase === 'cold-start'
          ? COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS
          : RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS,
      onBeforeRecheck: ({ status, code, delayMs }) =>
        log.warn(
          `${opts.phase} refresh: stale refresh token failed status=${status} code=${code ?? '<none>'}, no replacement token on disk yet — re-reading after ${delayMs}ms before clearing auth`,
        ),
    },
    onReplacementRetry: ({ status, code }) =>
      log.warn(
        `${opts.phase} refresh: replacement-retry supersedes definitive failure status=${status} code=${code ?? '<none>'} — retrying with token written by another app instance`,
      ),
  });

  if (run.replacementRetryExhausted) {
    log.warn(
      `${opts.phase} refresh: stale refresh token kept being replaced after ${run.replacementRetries} replacement retries; keeping latest token on disk`,
    );
  }

  return run;
}

// ── Renderer notification ───────────────────────────────────────────────────

/**
 * 广播到所有未销毁的 BrowserWindow。
 *
 * 不能用 `BrowserWindow.getAllWindows()[0]` —— 隐藏的辅助窗口
 * (hidden + skipTaskbar + focusable:false)可能排在 [0]。这条踩坑在 `bootstrap-electron.ts:557-559` 已经为 `focusMainWindow`
 * 显式记录过;这里曾经用 [0] 发 'auth:state-change',结果是登出后真正的
 * 主窗 renderer 永远收不到 state-change,`isAuthenticated` 留在 true,
 * ProtectedRoute 不跳 /login —— 表现就是"settings 里点退出后界面没反应"。
 *
 * 项目内 IM / spend / maker / mcp-integrations 等广播器都是 forEach 全部
 * 窗口,本函数沿用同样语义;overlay 等无 listener 的窗口会忽略该事件,无副作用。
 */
function broadcastToRenderers(channel: string, payload: unknown): void {
  const ownerStamp = getActiveDataOwnerPushStamp();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (ownerStamp === undefined) win.webContents.send(channel, payload);
      else win.webContents.send(channel, payload, ownerStamp);
    } catch (err) {
      log.warn(`broadcast '${channel}' to window failed (non-fatal)`, err);
    }
  }
}

/**
 * 当前登录态快照(所有状态出口共用)。
 *
 * `currentUser` 即服务端真值的合并展示态(auth-server membership 为主、
 * product /me 增强字段与头像回落)。2026-07 自助资料上线后,名字/头像
 * 修改直接写 auth-server(updateServerProfile),本地覆写层已退役。
 */
function snapshotAuthState(): AuthState {
  const appSession = getActiveAppSession();
  const isCloudAuthenticated =
    appSession.mode === 'cloud' && accessToken !== null && currentUser !== null;
  return {
    // orgSlug 在出口处统一从当前 access token 解码注入(token 与 currentUser
    // 总是成对更新,快照读取时两者一致)。这里显式投影公开字段,避免 main-only
    // membershipDisplayName 意外透传到 renderer。
    user: currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
          email: currentUser.email,
          defaultModel: currentUser.defaultModel,
          defaultEffort: currentUser.defaultEffort,
          membershipKind: currentUser.membershipKind,
          membershipRole: currentUser.membershipRole,
          orgId: currentUser.orgId,
          orgName: currentUser.orgName,
          orgSlug: decodeAccessTokenOrgSlug(accessToken),
          orgLogoUrl: currentUser.orgLogoUrl,
          passportId: currentUser.passportId,
        }
      : null,
    mode: appSession.mode,
    dataOwnerId: appSession.dataOwnerId,
    ownerGeneration: appSession.generation,
    // IPC pending is not a logout. Real owner change / logout still holds the
    // shell closed so a late notifyRenderer() cannot remount the outgoing owner.
    canEnterApp: appSession.mode !== 'signed-out' && !isOwnerChangeShellPending(),
    isAuthenticated: isCloudAuthenticated,
    isCanary: currentUser !== null && canaryFlagStore.read(),
    deviceId,
    hasAccountDeletionReceipt: readPersistedAccountDeletionReceipt() !== null,
    accountDeletionRestored: accountDeletionRestoredNoticePending,
    credentialStoreUnavailable: credentialStoreHealth.unavailable,
  };
}

/** Logged-out projection used by stale/timeout paths that must not expose newer auth state. */
function snapshotLoggedOutAuthState(ownerBoundaryPending = false): AuthState {
  const appSession = getActiveAppSession();
  return {
    user: null,
    mode: 'signed-out',
    dataOwnerId: null,
    ownerGeneration: appSession.generation,
    ownerBoundaryPending,
    canEnterApp: false,
    isAuthenticated: false,
    isCanary: false,
    deviceId,
    hasAccountDeletionReceipt: readPersistedAccountDeletionReceipt() !== null,
    accountDeletionRestored: false,
    // Startup recovery errors are returned by getLoginState; this projection
    // also serves stale/timeout paths and must not expose another owner's health.
    credentialStoreUnavailable: false,
  };
}

function notifyRenderer(): void {
  broadcastToRenderers('auth:state-change', snapshotAuthState());
}

function notifyRendererAuthBoundaryPending(): void {
  broadcastToRenderers('auth:state-change', snapshotLoggedOutAuthState(true));
}

/**
 * Preserve the dedicated forced-logout UX while leaving copy localization to
 * the renderer. Never expose auth-server messages or internal reason codes —
 * `reason` is a client-side classification enum (SessionExpiredReason), not a
 * server string, so the renderer can pick a localized "signed out elsewhere /
 * expired / account unavailable" copy without leaking internals.
 */
function notifySessionExpired(reason: SessionExpiredReason = 'unknown'): void {
  broadcastToRenderers('auth:session-expired', { message: '', reason });
}

// ── In-process auth state subscription ─────────────────────────────────────
//
// In addition to renderer broadcast (auth:state-change), main-process modules
// can subscribe to auth state transitions here. Used by main/im to
// disconnect the IM channel on logout and re-init / re-sync whitelist on
// login. Listeners are called synchronously after `currentUser` is updated;
// they MUST NOT throw.

type AuthListener = (state: AuthState) => void;
const authStateListeners = new Set<AuthListener>();

export function onAuthStateChange(listener: AuthListener): () => void {
  authStateListeners.add(listener);
  return () => authStateListeners.delete(listener);
}

function notifyAuthListeners(): void {
  const state = snapshotAuthState();
  for (const l of authStateListeners) {
    try {
      l(state);
    } catch (err) {
      log.error('auth state listener threw (non-fatal)', err);
    }
  }
}

// Token rotation does not imply an identity change. Connections rejected with 401
// need this synchronous signal even when the retry was started by our timer.
const accessTokenRefreshListeners = new Set<() => void>();

export function onAccessTokenRefreshed(listener: () => void): () => void {
  accessTokenRefreshListeners.add(listener);
  return () => accessTokenRefreshListeners.delete(listener);
}

function notifyAccessTokenRefreshed(): void {
  for (const listener of accessTokenRefreshListeners) {
    try {
      listener();
    } catch (err) {
      log.error('access token refresh listener threw (non-fatal)', err);
    }
  }
}

// ── Auth state management ───────────────────────────────────────────────────

async function clearPerAccountIntegrations(): Promise<void> {
  // 登录账号级集成清单当前为空(2026-07-17 起):
  // - 飞书 token 链随 refresh-feishu 退役——xd-feishu 意识改走 OAuth broker,
  //   凭证是机器级意识保险库,登出不清(与 Atlassian / Slack / Google 同语义);
  // - Jira/Confluence 清理已随 lizi_jira 退役(2026-07-14);
  // - Slack 官方 MCP 清理已随 slack-official 退役(2026-07-15)。
  // 骨架保留:未来出现真正跟登录账号绑定的集成时在此登记,refresh() 的
  // 账号切换 teardown 守卫链依赖本函数的调用位。
}

function clearPerAccountIntegrationsInBackground(): void {
  void clearPerAccountIntegrations().catch((err) => {
    log.error('clear per-account integrations failed', err);
  });
}

/** Clear renderer-safe login progress and all main-only login tickets. */
function resetActiveAuthRealmToBuild(): void {
  activeAuthRealm = AUTH_REGION;
  resetClientEndpointRealm();
}

async function reloadPerAccountIntegrationsFromDisk(_accessToken: string | null): Promise<void> {
  void _accessToken;
  // 登录账号级集成清单当前为空(见 clearPerAccountIntegrations 顶注)。
  // 骨架与重试调度保留:替换式刷新的账号切换路径依赖本函数的调用位与
  // 'after-integration-reload' 守卫点。
}

function scheduleReplacementIntegrationReloadRetries(userId: string): void {
  clearReplacementIntegrationReloadTimers();
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const delayMs of REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      replacementIntegrationReloadTimers = replacementIntegrationReloadTimers.filter(
        (candidate) => candidate !== timer,
      );
      void (async () => {
        if (currentUser?.id !== userId || !accessToken) return;
        await reloadPerAccountIntegrationsFromDisk(accessToken);
      })().catch((err) => {
        log.error(
          `delayed integration reload after replacement account switch failed delayMs=${delayMs}`,
          err,
        );
      });
    }, delayMs);
    timers.push(timer);
  }
  replacementIntegrationReloadTimers = timers;
}

function clearAuth(
  opts: {
    notify?: boolean;
    nextMode?: Extract<AppSessionMode, 'signed-out' | 'local'>;
    /** Preserve the reason a saved login could not be restored through owner cleanup. */
    credentialStoreUnavailable?: boolean;
    /**
     * 为 true 时不删除磁盘上的 refresh token 文件。仅用于「凭证已确认缺席」的
     * 过期路径(credential-lost):此刻磁盘上没有属于本进程的 token 可清,而共享
     * userData 的另一个实例可能刚好在登出→重登间隙写入了新 token——无条件
     * removeSafe 会把别人的新 token 删掉,把对方也踢成半死。
     */
    preservePersistedRefreshToken?: boolean;
    /**
     * Clear auth fields immediately, but defer publishing the signed-out
     * owner until the enclosing teardown completes. Owner-bound consumers are
     * blocked while the boundary is pending so they cannot enter a temporary
     * namespace during teardown.
     */
    deferSessionCommit?: boolean;
    /**
     * 本次清理是冷启动启动闸超时的兜底(不是用户动作)。为 true 时在**推进代际的
     * 同一同步时刻**记下该代际,让触发兜底的冷启动流程即使在本函数外层还没返回、
     * 锁还没释放时也能认出「这一代是我自己的兜底」而不是用户改过登录态。
     * 见 authStartupGate 的 ColdStartAuthFallbackRegistry。
     */
    coldStartTimeoutRecovery?: boolean;
  } = {},
): void {
  const notify = opts.notify ?? true;
  const epochBeforeClear = authStateEpoch;
  authStateEpoch += 1; // 迟到的冷启动流程从此作废(见 authStateEpoch 注释)
  // 必须与上一行同步记录:兜底流程外层还有 await commit / 释放锁 / 多层异步返回,
  // 期间并发的刷新已经能看到新代际;若等到外层返回才登记,它仍会被误判为
  // 「用户改过登录态」而丢弃(PR #6273 review P1)。
  if (opts.coldStartTimeoutRecovery) {
    coldStartTimeoutFallbacks.record(epochBeforeClear, authStateEpoch);
  } else {
    // A user logout/login or any non-timeout clear breaks the fallback chain even
    // when no refresh guard ran between that action and a sibling window timeout.
    coldStartTimeoutFallbacks.clear();
    coldStartRetryWait?.(true);
  }
  refreshBackoff.clear();
  // Explicit logout clears health. Failed startup keeps its recovery reason
  // in the same synchronous commit, so owner cleanup cannot erase the error.
  credentialStoreHealth.reset();
  if (opts.credentialStoreUnavailable) credentialStoreHealth.noteStartupFailure();
  accessToken = null;
  currentUser = null;
  accountDeletionRestoredNoticePending = false;
  confirmedAccountDeletionCredential = null;
  persistedRefreshTokenNeedsIdentityCheck = false;
  lastAcceptedRefreshToken = null;
  clearReplacementIntegrationReloadTimers();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!opts.preservePersistedRefreshToken) {
    if (isPassiveSharedUserDataInstance()) {
      // passive 共享实例无权删整机凭证:它的登出只清本进程内存态,磁盘 token 留给
      // primary(见 isPassiveSharedUserDataInstance 的事故记录)。同时立墓碑,否则
      // 下一次 initialize() 会拿 primary 的 token 把本进程登回去。
      passiveLocalSignOut = true;
      log.info(
        'passive shared-userData instance keeps the persisted refresh token (local sign-out only)',
      );
    } else {
      removeSafe(AUTH_SESSION_KEY);
      removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);
      removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
      removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    }
  }
  resetActiveAuthRealmToBuild();
  // 未登录时固定使用 stable；同步中的旧请求会被 authStateEpoch 守卫丢弃。
  // canary-flag.json 同样是整机一份的账号派生状态:passive 清掉它,packaged primary
  // 下次更新轮询就会把自己当 stable 用户,拉到错误的 manifest(见 manifestService
  // fetchManifest)。passive 只登出本进程,不改这个共享文件。
  if (!isPassiveSharedUserDataInstance()) {
    canaryFlagStore.clear();
  }
  // provider key(XD / Mivo)是绑定账号的本机密钥,**不在登出时清** —— 同账号重新登录 /
  // 会话过期重登需保留,避免每次都重填(本地 only 后服务器已无副本可拉回)。换账号导致的
  // 串号边界改由 login / 冷启动时 providerSecretStore.reconcileOwner 处理:owner 变了才清。
  // clearAuth 必须保持同步(大量调用方依赖立即 notify),但 promise rejection 仍要吞掉并记日志。
  clearPerAccountIntegrationsInBackground();
  if (!opts.deferSessionCommit) {
    commitActiveAppSession(opts.nextMode ?? 'signed-out');
  }
  if (notify) {
    notifyRenderer();
    notifyAuthListeners();
  }
}

/**
 * Expire a live cloud session after a definitive refresh failure.
 *
 * Auth expiry is an owner boundary just like logout: clear the auth state
 * before awaiting teardown so no new owner-bound work can start, then stop
 * every account-scoped runtime and publish the final signed-out state.
 */
async function expireRuntimeAuth(
  previousUserId: string,
  reason: SessionExpiredReason = 'unknown',
  opts: { preservePersistedRefreshToken?: boolean } = {},
): Promise<void> {
  const expiredAccountKey = currentUser ? accountVaultKey(activeAuthRealm, currentUser.id) : null;
  if (
    expiredAccountKey &&
    !opts.preservePersistedRefreshToken &&
    !isPassiveSharedUserDataInstance()
  ) {
    try {
      await removeVaultAccount(expiredAccountKey);
    } catch (error) {
      log.warn('failed to remove expired account from saved-account vault', error);
    }
  }
  // Raise the owner boundary before clearing auth so queued owner-scoped
  // continuations see the pending boundary and fail closed, rather than
  // executing between token clearance and the async teardown (P1,
  // PRRT_kwDOTgdRUs6YaakC).  beginAppSessionBoundary is ref-counted;
  // withAccountFreeOwnerCommit will extend it, and the finally block
  // releases the outer reference after teardown completes.
  const releaseBoundary = beginAppSessionBoundary();
  clearAuth({
    notify: false,
    nextMode: 'signed-out',
    preservePersistedRefreshToken: opts.preservePersistedRefreshToken,
    deferSessionCommit: true,
  });
  try {
    await withAccountFreeOwnerCommit({
      reason,
      nextMode: 'signed-out',
      preservePersistedRefreshToken: opts.preservePersistedRefreshToken,
      notify: false,
      clearOnFailure: true,
      authAlreadyCleared: true,
    });
  } catch (err) {
    // A teardown or durable-state failure must not restore an expired
    // credential. The helper has already cleared the in-memory owner; leave
    // the durable boundary non-stable for the next recovery attempt.
    log.error('runtime auth expiry owner transition failed', err);
  } finally {
    releaseBoundary();
    notifyRenderer();
    notifyAuthListeners();
    notifySessionExpired(reason);
  }
}

/**
 * Terminal auth rejection (deleted/disabled account or definitively invalid
 * credentials) must cross the same full account boundary as an explicit
 * logout. The single-flight guard prevents parallel API/refresh failures from
 * racing teardown and local credential deletion.
 */
export function invalidateSession(reason: string): Promise<void> {
  if (sessionInvalidationPromise) return sessionInvalidationPromise;

  const rejectedAccountKey =
    currentUser && !isPassiveSharedUserDataInstance()
      ? accountVaultKey(activeAuthRealm, currentUser.id)
      : null;

  // Raise the owner boundary before clearing auth (same P1 fix as
  // expireRuntimeAuth — see PRRT_kwDOTgdRUs6YaakC).
  const releaseBoundary = beginAppSessionBoundary();
  clearAuth({ notify: false, nextMode: 'signed-out', deferSessionCommit: true });

  // Schedule teardown one microtask later so the single-flight promise can be
  // published and credentials can be cleared synchronously first. API calls
  // that detect the rejection may themselves run inside a scheduler/service
  // being torn down; they must be able to unwind without a stop-await cycle.
  const run = Promise.resolve().then(async () => {
    if (rejectedAccountKey) {
      try {
        await removeVaultAccount(rejectedAccountKey);
      } catch (error) {
        log.warn('failed to remove rejected account from saved-account vault', error);
      }
    }
    try {
      await withAccountFreeOwnerCommit({
        reason,
        nextMode: 'signed-out',
        notify: false,
        clearOnFailure: true,
        authAlreadyCleared: true,
      });
    } catch (error) {
      log.error(`auth session owner transition on ${reason} failed`, error);
    } finally {
      releaseBoundary();
    }
    notifyRenderer();
    notifyAuthListeners();
  });
  sessionInvalidationPromise = run;
  // invalidateSession 的 reason 是调用方语境串而非服务端失效码,这里只把
  // 「账号不可用」显式归类,其余统一走通用过期文案。
  notifySessionExpired(reason === 'account-unavailable' ? 'account-unavailable' : 'unknown');

  const clearIfCurrent = (): void => {
    if (sessionInvalidationPromise === run) sessionInvalidationPromise = null;
  };
  void run.then(clearIfCurrent, clearIfCurrent);
  return run;
}

/** Ensure a terminal auth teardown has finished before a new local owner commits. */
export async function waitForSessionInvalidation(): Promise<void> {
  if (sessionInvalidationPromise) await sessionInvalidationPromise;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return accessToken;
}

/** 当前已认证会话的数据区域；主进程长连接据此识别同账号的跨区切换。 */
export function getActiveAuthRealm(): AuthRegion {
  return activeAuthRealm;
}

/** SkillHub v0.2.1: 返回当前登录用户 id（cuid），未登录时返回 null */
export function getCurrentUserId(): string | null {
  return currentUser?.id ?? null;
}

/**
 * Public issue attribution may only use the raw auth membership display name.
 * UI fallbacks (`email` / "Cindy") are intentionally excluded for privacy.
 */
export function getCurrentMembershipDisplayName(): string | undefined {
  const displayName = currentUser?.membershipDisplayName.trim();
  return displayName || undefined;
}

/** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都可用 */
export function getDeviceId(): string {
  return deviceId;
}

export function getAuthState(): AuthState {
  return snapshotAuthState();
}

export function getCurrentDataOwnerId(): string | null {
  return getActiveAppSession().dataOwnerId;
}

export function isLocalMode(): boolean {
  return getActiveAppSession().mode === 'local';
}

/**
 * 本机是否**确定**没有任何可用于恢复登录的持久凭证(只读判定:不解密、不轮换、不写盘)。
 *
 * 唯一消费者是 analytics 的存量同意迁移关窗判定(见
 * analyticsSettingsService.noteAuthColdStartState)。它必须区分两种「冷启动未登录」:
 *   - 真的没有账号(新装 / 跳过登录已清凭证)→ 本机不是存量账号,可以永久关窗;
 *   - 有账号但本次 initialize() **刻意保留了 token**:对端区域清单暂不可用、或
 *     cold-start refresh 瞬态失败(见本文件那两处 `keeping ... token, starting
 *     logged out`)。这类用户下一次冷启动就会恢复成真实的存量账号,一旦被关窗就
 *     永远拿不到本该有的同意迁移。
 *
 * 判定复用 `isPersistedSecretAbsent`(只认 ENOENT 为真缺席,密钥链不可用 / EPERM /
 * 解密失败一律按瞬时故障),所以任何不确定都会让本函数返回 false = 「可能还有凭证」
 * → 调用方不关窗。取舍方向是刻意的:宁可让一台机器多留一次迁移机会,也不要把真存量
 * 用户永久误判(未同意侧另有 probe / override / 协议门三道闸兜底)。
 */
export function hasNoPersistedAuthCredentials(): boolean {
  return (
    isPersistedSecretAbsent(AUTH_SESSION_KEY) &&
    isPersistedSecretAbsent(LEGACY_RESOURCE_REFRESH_TOKEN_KEY) &&
    isPersistedSecretAbsent(AUTH_ACCOUNT_VAULT_KEY)
  );
}

function requireAccountDeletionAccessToken(): string {
  if (!accessToken || !currentUser) {
    throw new AuthApiError('UNAUTHENTICATED', 401, 'Account deletion requires an active login');
  }
  return accessToken;
}

function currentAccountDeletionAuthIdentity(): string | null {
  if (!accessToken || !currentUser) return null;
  return currentUser.passportId || currentUser.id;
}

function commitAccountDeletionConfirmation(
  expectedIdentity: string,
  expectedRealm: AuthRegion,
  status: AccountDeletionStatus,
): AccountDeletionStatus {
  if (
    currentAccountDeletionAuthIdentity() !== expectedIdentity ||
    activeAuthRealm !== expectedRealm
  ) {
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Account deletion was superseded by a newer auth action',
    );
  }
  confirmedAccountDeletionCredential = {
    identity: expectedIdentity,
    realm: expectedRealm,
  };
  return status;
}

/** Run an authenticated auth-client request through the terminal auth boundary. */
async function runProtectedAuthRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof AuthApiError &&
      error.statusCode === 401 &&
      error.code === 'ACCOUNT_UNAVAILABLE'
    ) {
      void invalidateSession('account-unavailable');
    }
    throw error;
  }
}

/** Server-controlled visibility and verification channel for personal-account deletion. */
export function getAccountDeletionAvailability(): Promise<AccountDeletionAvailability> {
  const token = requireAccountDeletionAccessToken();
  return runProtectedAuthRequest(() => createAuthClient().getAccountDeletionAvailability(token));
}

/**
 * Request an OTP and persist its receipt before returning display-safe challenge
 * data. The receipt never crosses into renderer and survives the initiating
 * desktop's immediate local logout after confirmation.
 */
export async function requestAccountDeletionChallenge(): Promise<DesktopAccountDeletionChallenge> {
  confirmedAccountDeletionCredential = null;
  const token = requireAccountDeletionAccessToken();
  const expectedIdentity = currentAccountDeletionAuthIdentity();
  const expectedRealm = activeAuthRealm;
  if (!expectedIdentity) {
    throw new AuthApiError('UNAUTHENTICATED', 401, 'Account deletion requires an active login');
  }
  const challenge = await runProtectedAuthRequest(() =>
    createAuthClient(expectedRealm).requestAccountDeletionChallenge(token),
  );
  if (
    currentAccountDeletionAuthIdentity() !== expectedIdentity ||
    activeAuthRealm !== expectedRealm
  ) {
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Account deletion was superseded by a newer auth action',
    );
  }
  if (
    !writePersistedAccountDeletionReceipt(challenge.receiptToken, expectedRealm, expectedIdentity)
  ) {
    throw new AuthApiError(
      'ACCOUNT_DELETION_RECEIPT_STORE_FAILED',
      0,
      'Could not securely store the account deletion receipt',
    );
  }
  return {
    challengeId: challenge.challengeId,
    channel: challenge.channel,
    maskedTarget: challenge.maskedTarget,
    expiresAt: challenge.expiresAt,
  };
}

/**
 * Confirm deletion with the main-only receipt. If the response is ambiguous,
 * query that receipt to distinguish an accepted request from a retryable error.
 */
export async function confirmAccountDeletion(input: {
  challengeId: string;
  code: string;
}): Promise<AccountDeletionStatus> {
  const token = requireAccountDeletionAccessToken();
  const expectedIdentity = currentAccountDeletionAuthIdentity();
  if (!expectedIdentity) {
    throw new AuthApiError('UNAUTHENTICATED', 401, 'Account deletion requires an active login');
  }
  confirmedAccountDeletionCredential = null;
  const receipt = readPersistedAccountDeletionReceipt();
  if (!receipt) {
    throw new AuthApiError(
      'ACCOUNT_DELETION_RECEIPT_MISSING',
      400,
      'Request a new account deletion challenge',
    );
  }
  if (
    receipt.version !== 2 ||
    receipt.authIdentity !== expectedIdentity ||
    receipt.realm !== activeAuthRealm
  ) {
    if (!isPassiveSharedUserDataInstance()) {
      removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);
    }
    throw new AuthApiError(
      'ACCOUNT_DELETION_RECEIPT_MISSING',
      400,
      'Request a new account deletion challenge',
    );
  }
  const client = createAuthClient(receipt.realm);
  let status: AccountDeletionStatus;
  try {
    status = await runProtectedAuthRequest(() =>
      client.confirmAccountDeletion(token, {
        ...input,
        receiptToken: receipt.receiptToken,
        acknowledged: true,
      }),
    );
  } catch (error) {
    const ambiguous =
      error instanceof AuthApiError &&
      ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code);
    if (!ambiguous) throw error;
    const recovered = await client.getAccountDeletionStatus(receipt.receiptToken).catch(() => null);
    if (!recovered || recovered.status === 'cancelled') throw error;
    status = recovered;
  }
  return commitAccountDeletionConfirmation(expectedIdentity, receipt.realm, status);
}

/** Query the persisted receipt without requiring an authenticated session. */
export async function getAccountDeletionStatus(): Promise<AccountDeletionStatus | null> {
  const receipt = readPersistedAccountDeletionReceipt();
  if (!receipt) return null;
  await loadClientEndpointsForRealm(receipt.realm);
  return createAuthClient(receipt.realm).getAccountDeletionStatus(receipt.receiptToken);
}

/**
 * 显式清除账号删除 receipt。
 *
 * 注意这不只是 logout 的内部步骤:它经 `auth:account-deletion:clear-receipt`
 * (bootstrap-electron.ts)暴露给 renderer,用户在登录页处理无效/已取消的挑战、
 * 或 dismiss 已完成的删除状态时会直接调到。这类显式清理在 passive 实例上必须
 * 照常生效 —— 否则 receipt 永远留在盘上,`snapshotAuthState()` 每次启动又把它
 * 报出来,dismiss 不掉。
 *
 * 需要保护的只有「passive 登出顺带清掉 primary 的 receipt」那条隐式路径,闸门
 * 因此加在 logout() 的调用点上,不在这里。
 */
export function clearAccountDeletionReceipt(): void {
  removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);
}

/** Consume the successful-login recovery notice exactly once per main process. */
export function consumeAccountDeletionRestoredNotice(): boolean {
  if (!accountDeletionRestoredNoticePending) return false;
  accountDeletionRestoredNoticePending = false;
  return true;
}

/**
 * Clear only local auth after the server accepted deletion. Ordinary logout is
 * deliberately skipped because the refresh family is already revoked and the
 * receipt must remain available on the login screen.
 */
export function isConfirmedAccountDeletionSessionCurrent(): boolean {
  return (
    confirmedAccountDeletionCredential !== null &&
    currentAccountDeletionAuthIdentity() === confirmedAccountDeletionCredential.identity &&
    activeAuthRealm === confirmedAccountDeletionCredential.realm
  );
}

export async function clearLocalSessionAfterAccountDeletion(): Promise<boolean> {
  if (!isConfirmedAccountDeletionSessionCurrent()) return false;
  const expectedCredential = confirmedAccountDeletionCredential;
  const deletedPassportId = currentUser?.passportId ?? null;
  const deletedRealm = activeAuthRealm;
  if (deletedPassportId && !isPassiveSharedUserDataInstance()) {
    try {
      await mutateAuthAccountVault((vault) => {
        for (const [key, resource] of Object.entries(vault.resources)) {
          if (
            resource.realm === deletedRealm &&
            resource.metadata.passportId === deletedPassportId
          ) {
            delete vault.resources[key];
            if (vault.activeAccountKey === key) vault.activeAccountKey = null;
          }
        }
        delete vault.passports[passportVaultKey(deletedRealm, deletedPassportId)];
      });
    } catch (error) {
      // The server has already accepted deletion and revoked this credential
      // family. Vault cleanup is best-effort; runtime teardown must still run.
      log.warn('failed to remove deleted account from saved-account vault', error);
    }
  }
  await withAccountFreeOwnerCommit({
    reason: 'account-deletion',
    nextMode: 'signed-out',
    clearOnFailure: true,
    validateBeforeCommit: () =>
      expectedCredential !== null &&
      confirmedAccountDeletionCredential === expectedCredential &&
      isConfirmedAccountDeletionSessionCurrent(),
    shouldClearOnFailure: () =>
      expectedCredential !== null &&
      confirmedAccountDeletionCredential === expectedCredential &&
      isConfirmedAccountDeletionSessionCurrent(),
  });
  return true;
}

/**
 * 当前展示资料(profileEdit 弹窗预填用)。未登录返回 null。
 */
export function getServerProfile(): { name: string; avatar: string | null } | null {
  if (!currentUser) return null;
  return { name: currentUser.name, avatar: currentUser.avatar };
}

/** PATCH /api/me/profile 的入参(至少提供一个字段;avatarUrl null = 清除头像)。 */
export interface ServerProfilePatch {
  displayName?: string;
  avatarUrl?: string | null;
}

interface PatchProfileResponse {
  membership?: AuthMembership;
  error?: { code?: string; message?: string };
}

export type UpdateServerProfileResult =
  | { ok: true; profile: { name: string; avatar: string | null } }
  | { ok: false; status: number; code?: string };

/**
 * 自助修改昵称/头像:PATCH auth-server /api/me/profile(2026-07 上线,替代
 * 旧的本地覆写方案)。成功后用响应 membership 就地更新 currentUser 并广播
 * 登录态;头像清除(avatarUrl:null)后 UI 回落首字母兜底(产品资料头像
 * 回落已随 /api/user/me 退役)。
 * 网络/服务端失败返回 ok:false(status 0 = 网络层失败),不抛异常——
 * IPC 错误语义由调用方 profileEdit 统一映射。
 */
export async function updateServerProfile(
  patch: ServerProfilePatch,
): Promise<UpdateServerProfileResult> {
  if (!accessToken || !currentUser) {
    return { ok: false, status: 0, code: 'NOT_AUTHENTICATED' };
  }
  const epochAtStart = authStateEpoch;
  const result = await apiFetch<PatchProfileResponse>('/api/me/profile', {
    method: 'PATCH',
    body: patch,
    token: accessToken,
  });
  if (!result.ok) {
    const code = result.data?.error?.code;
    if (result.status === 401 && code === 'ACCOUNT_UNAVAILABLE') {
      void invalidateSession('account-unavailable');
    }
    return { ok: false, status: result.status, ...(code !== undefined ? { code } : {}) };
  }
  const membership = result.data?.membership;
  // 请求期间登出/换号则不回写全局态(服务端已改成功,下次登录自然拉到新值)。
  if (
    membership &&
    authStateEpoch === epochAtStart &&
    currentUser !== null &&
    currentUser.id === membership.id
  ) {
    currentUser = {
      ...currentUser,
      name: membership.displayName || currentUser.name,
      membershipDisplayName: membership.displayName,
      avatar: membership.avatarUrl ?? null,
    };
    await rememberUpdatedMembershipMetadata(
      membership,
      activeAuthRealm,
      membership.passportId ?? currentUser.passportId,
    );
    notifyRenderer();
    notifyAuthListeners();
    return { ok: true, profile: { name: currentUser.name, avatar: currentUser.avatar } };
  }
  return {
    ok: true,
    profile: {
      name: membership?.displayName ?? '',
      avatar: membership?.avatarUrl ?? null,
    },
  };
}

/**
 * Sign-in is removed, so a profile whose last run was signed in would reopen
 * as an empty local-v1 owner while its tasks, provider keys and owner directory
 * stay under the former membership id. Adopt that membership (read from the
 * encrypted account vault, never refreshed or sent anywhere) as the account-free
 * owner once. No data is moved; a profile that last ran local or signed out is
 * left on local-v1.
 */
function adoptFormerCloudOwnerOnce(): void {
  if (readPersistedAppSessionMode() !== 'cloud') return;
  if (accountFreeDataOwnerId() !== LOCAL_DATA_OWNER_ID) return;
  let vault: AuthAccountVault;
  try {
    vault = readAuthAccountVault();
  } catch (error) {
    log.warn('former cloud owner could not be read; staying on local-v1', requestErrorMessage(error));
    return;
  }
  const key = vault.activeAccountKey;
  const ownerId = key ? vault.resources[key]?.metadata.membershipId : undefined;
  if (!ownerId) return;
  adoptAccountFreeDataOwner(ownerId, { persist: !isPassiveSharedUserDataInstance() });
}

export async function initialize(options: AuthInitializeOptions = {}): Promise<AuthState> {
  const initializeStartEpoch = authStateEpoch;
  // A renderer can mount after the boundary-pending broadcast. Keep startup
  // fail-closed until the serialized owner transition settles instead of
  // restoring the outgoing owner's credentials and turns from disk.
  if (isOwnerChangeShellPending()) {
    return snapshotLoggedOutAuthState(true);
  }
  // Local mode is a committed account-free session. It must win before any
  // persisted cloud refresh token is inspected or any auth network call runs.
  if (getActiveAppSession().mode === 'local') {
    adoptFormerCloudOwnerOnce();
    await recoverAccountFreeOwnerAtStartup('local', 'cold-start-local-recovery');
    return snapshotAuthState();
  }
  // 进程内已登录快路径:auth 状态是 main 进程全局的,主窗登录后其它 renderer
  // (会话多开副窗 / 右侧栏子窗口)mount 时各自都会调一次 auth:initialize ——
  // 没有这条快路径,每个新窗口都会重跑一整轮网络 refresh(token 轮换 + /me),
  // 期间该窗口 isAuthenticated=false,慢网/瞬时失败会闪现登录页;且冗余的
  // refresh 轮换还有并发失效风险。已登录时直接回缓存态,零网络、无闪屏。
  // 冷启动时 accessToken/currentUser 必为空,不影响下方完整初始化流程
  // (relogin marker 消费、持久化 refresh_token 校验)。
  if (accessToken && currentUser) {
    if (!isGhostSkillProjectionBoundaryStableForOwner(currentUser.id)) {
      const previousSession = getActiveAppSession();
      await withCloudOwnerCommit({
        previousOwnerId: previousSession.dataOwnerId,
        nextOwnerId: currentUser.id,
        prepareTransition: async () => {
          if (!accountSwitchTeardown) {
            throw new Error('active cloud owner recovery requires a teardown hook');
          }
          await accountSwitchTeardown({
            previousUserId: previousSession.dataOwnerId ?? previousSession.mode,
            nextUserId: currentUser!.id,
          });
        },
        commit: () => commitCloudAppSession(currentUser!.id),
      });
    } else {
      // This owner is already durably authenticated. Repair missing first-owner
      // reservations best-effort, but never turn malformed local metadata into
      // a renderer-visible logout while main remains signed in.
      if (!isPassiveSharedUserDataInstance()) {
        await repairStableCloudOwnerDataReservations(currentUser.id);
      }
      commitCloudAppSession(currentUser.id);
    }
    await migrateLocalProviderBindingsAfterCloudCommit(currentUser.id);
    requestStableOwnerPostCommit('auth-initialize-stable-cloud');
    return snapshotAuthState();
  }

  // passive 实例在本进程登出过:磁盘上的 token 是 primary 的,不能拿它把自己登回去
  // （副窗 mount / renderer reload 都会走到这里）。直到显式登录或进程重启为止。
  if (passiveLocalSignOut) {
    log.info('passive shared-userData instance stays signed out locally (tombstone)');
    commitVolatileAppSession('signed-out');
    return snapshotLoggedOutAuthState();
  }
  if (foreignDeviceLocalSignOut) {
    log.info('foreign-device instance stays signed out locally (tombstone)');
    commitVolatileAppSession('signed-out');
    return snapshotLoggedOutAuthState();
  }
  if (coldStartRecoveryStopped) return snapshotLoggedOutAuthState();

  // release-relogin-on-update: if the auto-updater dropped a relogin marker
  // for *this* version, wipe persisted auth and force the user back to the
  // OAuth flow. The flag is one-shot: once consumed, subsequent launches
  // see no marker and no refresh_token, so the user stays logged out
  // naturally until they sign in (rather than getting kicked every launch).
  //
  // marker 是一次性的、整机一份:passive 若消费它,primary 就再也看不到这次
  // requireRelogin 更新的标记,而 passive 顺带删掉的又正是 primary 的 token ——
  // 本 PR 要防的失败被原样重现。
  //
  // 但「不消费」不等于「可以无视」:marker 命中说明这个版本要求重新登录,passive
  // 跑的是同一个版本,拿旧 token 冷启动登录正是 marker 想避免的事。所以 passive
  // 照样保持登出(复用 passiveLocalSignOut 墓碑,避免副窗 initialize() 又绕回来),
  // 只是不动磁盘 token、不消费 marker —— 那两件事留给 primary。
  const reloginFlag = readReloginFlag();
  if (reloginFlag && reloginFlag.version === app.getVersion()) {
    if (isPassiveSharedUserDataInstance()) {
      log.info(
        'relogin marker hit for v%s — passive shared-userData instance stays signed out, leaving the marker and token to the primary',
        reloginFlag.version,
      );
      passiveLocalSignOut = true;
      commitVolatileAppSession('signed-out');
      return snapshotLoggedOutAuthState();
    }
    log.info('relogin marker hit for v%s — clearing persisted auth', reloginFlag.version);
    lastAcceptedRefreshToken = null;
    removeSafe(AUTH_SESSION_KEY);
    await clearAuthAccountVault();
    removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    clearReloginFlag();
    return finishColdStartSignedOut('cold-start-relogin-required');
  }

  // Old Feishu-auth refresh tokens are intentionally not portable to auth-server.
  // 早期测试版曾持久化 account refresh token；该会话现已收窄为登录期内存态。
  //
  // 三个 legacy 凭证文件同样是整机一份,而 dev + packaged 共库双开是受支持的场景
  // (--preserve-running):老构建的 primary 可能还在消费它们,passive 只是启动一下
  // 就把它们删掉,等于删了对方的活凭证。清理属于「搬家式迁移」,留给独占启动的
  // 非 passive 实例做。
  if (!isPassiveSharedUserDataInstance()) {
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
  }
  let persistedSession: ReturnType<typeof readPersistedAuthSession>;
  try {
    persistedSession = await reconcileDesktopActiveAuthSession();
    credentialStoreHealth.noteRecovered();
  } catch (error) {
    log.warn(
      'cold-start active credential reconciliation failed; preserving credentials for retry',
      error,
    );
    return finishColdStartSignedOut(
      'cold-start-credential-reconcile-unavailable',
      credentialEncryptionUnavailable &&
        error instanceof AuthApiError &&
        error.code === 'CREDENTIAL_STORE_UNAVAILABLE' &&
        hasPotentiallyPersistedAuthCredentials(),
    );
  }
  if (!persistedSession) {
    // 旧版只保存裸 refresh token，没有 realm 可供校验。只有独占 userData 的
    // primary 才能按当前构建区域迁移它；passive 若猜 AUTH_REGION，恰好会在旧
    // cn / global 共库时把对端 token 认领成本区会话，随后 refresh 轮换并改写
    // primary 的凭证。这里 fail closed：保留旧文件，本进程稳定保持登出，等
    // 同区域的独占实例完成原子迁移。
    const legacyToken = readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);
    if (legacyToken && isPassiveSharedUserDataInstance()) {
      log.warn(
        'passive shared-userData instance found an unscoped legacy refresh token; refusing to assign a realm or rotate it',
      );
      passiveLocalSignOut = true;
      commitActiveAppSession('signed-out');
      return snapshotLoggedOutAuthState();
    }
    if (legacyToken && writePersistedAuthSession(legacyToken, AUTH_REGION)) {
      removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);
      persistedSession = { version: 1, realm: AUTH_REGION, refreshToken: legacyToken };
    }
  }
  if (!persistedSession) {
    return finishColdStartSignedOut('cold-start-no-persisted-session');
  }
  const storedToken = persistedSession.refreshToken;
  // Credential reconciliation above can yield to a manual login or owner change.
  if (coldStartRecoveryStopped || authStateEpoch !== initializeStartEpoch)
    return snapshotAuthState();

  // 进程内去重:主窗流程还挂着(黑洞网络)时,副窗 / 右侧栏窗口 mount 触发的
  // initialize() 复用同一个 in-flight promise,避免并发轮换同一枚 refresh token。
  if (coldStartAuthInFlight === null) {
    coldStartAuthInFlight = runColdStartRefreshFlow(storedToken, persistedSession.realm).finally(
      () => {
        // Keep every fallback edge until the shared refresh settles: sibling renderer
        // timeouts may append another edge while the network flow is still pending.
        coldStartTimeoutFallbacks.clear();
        coldStartAuthInFlight = null;
      },
    );
  }
  // 黑洞 / captive-portal 网络护栏:限时等待,超时先以未登录返回解锁 splash,
  // 流程继续后台跑;迟到成功由流程内部广播登录态(renderer 自动跳回主界面)。
  const coldStartCompletion = coldStartAuthInFlight;
  const startupTimeoutEpoch = initializeStartEpoch;
  return awaitWithStartupTimeout(coldStartCompletion, {
    timeoutMs: COLD_START_AUTH_GATE_TIMEOUT_MS,
    onTimeout: async () => {
      // A stopped recovery must not clear a newly opened manual login form,
      // even if sibling windows previously recorded startup fallback epochs.
      if (coldStartRecoveryStopped) return snapshotAuthState();
      options.onColdStartPending?.(coldStartCompletion);
      log.warn(
        `cold-start auth still pending after ${COLD_START_AUTH_GATE_TIMEOUT_MS}ms — recovering the account-free projection before startup continues`,
      );
      // A signed-out fallback is not safe until the shared Ghost projection
      // has been swept. Otherwise the previous cloud owner's links remain
      // available to local/anonymous Agent processes during a slow refresh.
      // The refresh may already have crossed into its owner teardown while the
      // startup deadline fires. That teardown owns the user-data boundary, so
      // never wait on it here (its awaits are unbounded) and never start a
      // competing account-free cleanup: return a fail-closed projection and let
      // the transition's own commit/rollback broadcast publish the settled state.
      const recovery = await resolveColdStartTimeoutRecovery({
        ownerTransitionPending: ownerChangeShellGate.isPending(),
        authChangedSinceInitialize: authStateEpoch !== initializeStartEpoch,
        isStartupFallbackEpoch: (epoch) =>
          epoch > initializeStartEpoch &&
          coldStartTimeoutFallbacks.containsOnlyFallbacks(initializeStartEpoch, epoch),
        timeoutStartEpoch: startupTimeoutEpoch,
        currentEpoch: authStateEpoch,
        currentState: snapshotAuthState(),
        pendingState: snapshotLoggedOutAuthState(true),
        recover: () =>
          recoverAccountFreeOwnerAtStartup('signed-out', 'cold-start-timeout-recovery', false, {
            coldStartTimeoutRecovery: true,
          }).then(() => snapshotLoggedOutAuthState()),
      });
      if (recovery.ownerBoundaryPending) {
        log.warn(
          'cold-start startup deadline reached during owner transition; keeping the shell fail-closed',
        );
      }
      return recovery;
    },
    onLateResult: (state) =>
      log.info(
        `cold-start auth settled after startup gate timeout — isAuthenticated=${state.isAuthenticated}`,
      ),
    onLateError: (err) => log.error('cold-start auth flow threw after startup gate timeout', err),
  });
}

/**
 * 冷启动 refresh 流程本体(从 initialize() 提取)。超时护栏可能把它转入后台继续
 * 执行——彼时用户已能操作登录页,因此每个全局状态写入点之前都必须核对
 * authStateEpoch:用户手动登录 / 登出过就整体丢弃迟到结果,绝不覆盖更新的登录态、
 * 不删除新登录写入的 refresh token(见 authStateEpoch 常量注释)。
 */
async function runColdStartRefreshFlow(
  storedToken: string,
  storedRealm: AuthRegion,
  ownershipRecovery: {
    attemptedTokens?: ReadonlySet<string>;
    expectedActiveVaultAccountKey?: string;
    hopsRemaining?: number;
  } = {},
): Promise<AuthState> {
  const attemptedOwnershipTokens = new Set(ownershipRecovery.attemptedTokens);
  attemptedOwnershipTokens.add(storedToken);
  const epochAtStart = authStateEpoch;
  /**
   * 本流程当前认可的代际。接受「自己的启动闸超时兜底」后前移到兜底那一代:
   * 提交后的灰度/组织默认同步必须用这个代际,否则本次恢复登录会被自己的兜底
   * 判成 stale-auth 而跳过同步(PR #6273 review P2);之后任何真实用户动作仍会
   * 再次推进代际,继续正确作废这些任务。
   */
  let flowAuthEpoch = epochAtStart;
  const epochChanged = (point: string): boolean => {
    if (coldStartRecoveryStopped) return true;
    const resolution = commitColdStartRefreshIfCurrent({
      registry: coldStartTimeoutFallbacks,
      flowEpoch: flowAuthEpoch,
      currentEpoch: authStateEpoch,
      commit: () => undefined,
    });
    if (!resolution.superseded) {
      // A committed result means the epoch is unchanged or every transition is
      // this flow's startup fallback. Adopt the committed epoch before post-login sync.
      flowAuthEpoch = resolution.flowEpoch;
      return false;
    }
    log.warn(
      `cold-start refresh flow superseded by manual auth change (${point}) — discarding late result`,
    );
    coldStartTimeoutFallbacks.clear();
    return true;
  };

  try {
    // Keep the shared recovery alive beyond the splash deadline. A network outage
    // must not turn a saved session into a fresh-login requirement. Each failed
    // attempt uses jittered exponential backoff; manual auth always wins.
    let run: Awaited<ReturnType<typeof runAuthRefreshWithReplacementRetry>>;
    for (;;) {
      if (epochChanged('before-recovery-attempt')) return snapshotAuthState();
      if (!ownershipRecovery.expectedActiveVaultAccountKey) {
        const latest = readPersistedAuthSession();
        if (!latest || latest.realm !== storedRealm) {
          return finishColdStartSignedOut('cold-start-persisted-session-changed');
        }
        storedToken = latest.refreshToken;
      }
      if (
        coldStartRetryState?.refreshToken !== storedToken ||
        coldStartRetryState.realm !== storedRealm
      ) {
        coldStartRetryState = {
          refreshToken: storedToken,
          realm: storedRealm,
          backoff: new AuthRefreshBackoff(),
        };
      }
      const retry = coldStartRetryState;
      await waitForColdStartRetry(retry);
      if (epochChanged('after-recovery-wait')) return snapshotAuthState();
      // Another shared-data instance may have rotated/switched while we waited.
      // Re-enter admission with its current credential instead of sending the old one.
      if (!ownershipRecovery.expectedActiveVaultAccountKey) {
        const latest = readPersistedAuthSession();
        if (latest?.realm !== storedRealm || latest.refreshToken !== storedToken) continue;
      }
      try {
        // Realm discovery can fail while offline too. Never fall back to sending
        // a saved credential to a different realm's refresh endpoint.
        await loadClientEndpointsForRealm(storedRealm);
      } catch (error) {
        retry.failure = { ok: false, status: 0, data: {} };
        retry.backoff.defer(0);
        if (epochChanged('after-realm-discovery')) return snapshotAuthState();
        log.warn('persisted auth realm manifest unavailable; keeping session for retry', error);
        continue;
      }
      if (epochChanged('before-refresh')) return snapshotAuthState();
      run = await runAuthRefreshWithReplacementRetry(storedToken, {
        phase: 'cold-start',
        realm: storedRealm,
        withTransientRetry: false,
      });
      // Replacement recovery may have consumed a newer credential. Keep this
      // attempt's deadline and failure history attached to the actual request,
      // including when a paused flow resumes from that credential on disk.
      storedToken = run.requestedToken;
      retry.refreshToken = storedToken;
      // A successful rotation must become durable even when publication was
      // stopped while the request was in flight. Credential ownership is checked
      // inside the existing vault transaction below, separately from UI epochs.
      if (run.result.ok) break;
      const transient =
        run.failureAction?.kind === 'transient-failure' ||
        run.failureAction?.kind === 'replacement-retry';
      if (transient) {
        retry.failure = run.result;
        retry.backoff.defer(0, run.result.retryAt);
      }
      if (epochChanged('after-recovery-attempt')) return snapshotAuthState();
      if (!transient) break;
      log.warn(
        `cold-start refresh failed status=${run.result.status} — keeping saved login and retrying in the background`,
      );
    }
    const { result: refreshResult, attempts, failureAction, rejectedTokens, requestedToken } = run;
    const credentialCommit = refreshResult.ok
      ? await commitDesktopRefreshCredentials(
          refreshResult.data as RefreshResponse,
          storedRealm,
          requestedToken,
          {
            allowUnclaimedVault: true,
          },
        )
      : undefined;
    if (
      refreshResult.ok &&
      coldStartRetryState?.refreshToken === storedToken &&
      coldStartRetryState.realm === storedRealm
    ) {
      coldStartRetryState = null;
    }
    if (epochChanged('after-cold-start-credential-commit')) return snapshotAuthState();
    const latestSession = readPersistedAuthSession();
    if (
      latestSession &&
      latestSession.realm !== storedRealm &&
      !ownershipRecovery.expectedActiveVaultAccountKey
    ) {
      // 共享 userData 的另一个实例已切到其它区域。旧区域请求无论成功失败都不能
      // 覆盖/删除新原子记录；本实例本次以未登录返回，后续 initialize 可加载新清单。
      log.warn('cold-start auth realm changed on disk; discarding stale refresh result');
      return finishColdStartSignedOut('cold-start-realm-changed');
    }
    if (!refreshResult.ok) {
      // 只在「确定性凭据失效」时清除 token。429 限流 / 5xx / 断网等瞬时失败保留 token,
      // 让下次启动(或后续 refresh)能恢复登录,避免冷启动撞限流 / 网络抖动即被永久登出。
      // 与运行时 refresh() 的清除条件保持一致(共用 authRefreshFailure)。
      const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
      if (action.kind === 'definitive-failure') {
        lastAcceptedRefreshToken = null;
        const confirmedDeadTokens = rejectedTokens.length > 0 ? rejectedTokens : [storedToken];
        const nextActiveCandidate = readActiveVaultRefreshCandidate();
        const hopsRemaining = ownershipRecovery.hopsRemaining ?? 3;
        if (
          nextActiveCandidate &&
          hopsRemaining > 0 &&
          !attemptedOwnershipTokens.has(nextActiveCandidate.refreshToken)
        ) {
          // A crash can leave the compatibility projection on the previous
          // account after the vault has already committed a switch. Never let
          // the stale projection win cold start: discard only the rejected
          // token(s), then retry the vault's active account.
          if (isPassiveSharedUserDataInstance()) {
            log.warn(
              'cold-start refresh: passive shared-userData instance keeps rejected compatibility tokens while retrying the vault active account',
            );
          } else {
            await clearConfirmedDeadRefreshTokens(storedRealm, confirmedDeadTokens);
            if (epochChanged('after-clearing-confirmed-dead-tokens')) {
              return snapshotAuthState();
            }
          }
          log.info(
            'cold-start refresh rejected a stale compatibility token; continuing with the vault active account',
          );
          return runColdStartRefreshFlow(
            nextActiveCandidate.refreshToken,
            nextActiveCandidate.realm,
            {
              attemptedTokens: attemptedOwnershipTokens,
              expectedActiveVaultAccountKey: nextActiveCandidate.accountKey,
              hopsRemaining: hopsRemaining - 1,
            },
          );
        }
        if (isPassiveSharedUserDataInstance()) {
          // passive 只对本进程判定失效:磁盘 token 是整机共用的,而 passive 冷启动拿到
          // INVALID_REFRESH_TOKEN 最常见的原因恰恰是 primary 刚轮换过它。删掉就是把
          // primary 踢下线。
          log.warn(
            'cold-start refresh: definitive credential failure — passive shared-userData instance starts logged out and keeps the persisted refresh token',
          );
        } else {
          // 必须逐一比对本轮被拒过的**每一枚** token,不能只认最初那枚:一旦本轮从另一个
          // 来源追赶过(replacement-retry),磁盘上现存的就是清单里较晚的那一枚,只拿最初
          // 的 token 做 compare-and-delete 会一律 changed,把已确认失效的凭证留在盘上,
          // 只读 legacy 的旧版实例继续拿它撞 INVALID_REFRESH_TOKEN 被强制重登。
          await clearConfirmedDeadRefreshTokens(storedRealm, confirmedDeadTokens);
        }
        resetActiveAuthRealmToBuild();
      } else if (action.kind === 'foreign-device') {
        log.warn(
          'cold-start refresh: DEVICE_MISMATCH — this process starts logged out and keeps the persisted refresh token',
        );
        foreignDeviceLocalSignOut = true;
      } else if (action.kind === 'replacement-retry') {
        log.warn(
          `cold-start refresh failed for a stale token after ${attempts} attempt(s) — keeping latest refresh token, starting logged out`,
        );
      } else {
        log.warn(
          `cold-start refresh still failing after ${attempts} attempt(s) — keeping refresh token, starting logged out`,
        );
      }
      return finishColdStartSignedOut(`cold-start-refresh-${action.kind}`);
    }

    const refreshData = refreshResult.data as RefreshResponse;
    attemptedOwnershipTokens.add(requestedToken);
    if (credentialCommit !== 'active') {
      log.warn(
        `cold-start refresh lost active credential ownership (${credentialCommit}); preserved only the still-saved account token`,
      );
      const nextActiveCandidate = readActiveVaultRefreshCandidate();
      const hopsRemaining = ownershipRecovery.hopsRemaining ?? 3;
      if (
        nextActiveCandidate &&
        hopsRemaining > 0 &&
        !attemptedOwnershipTokens.has(nextActiveCandidate.refreshToken)
      ) {
        log.info(
          'cold-start refresh preserved a non-active rotation; continuing with the vault active account',
        );
        return runColdStartRefreshFlow(
          nextActiveCandidate.refreshToken,
          nextActiveCandidate.realm,
          {
            attemptedTokens: attemptedOwnershipTokens,
            expectedActiveVaultAccountKey: nextActiveCandidate.accountKey,
            hopsRemaining: hopsRemaining - 1,
          },
        );
      }
      return finishColdStartSignedOut('cold-start-credential-ownership-lost');
    }
    lastAcceptedRefreshToken = refreshData.refreshToken;
    if (
      !canRestoreAuthSessionForMembership(AUTH_REGION, storedRealm, refreshData.membership.kind)
    ) {
      // The credential transaction above already preserved the rotated token
      // in its issuing realm. This process must not publish that identity.
      resetActiveAuthRealmToBuild();
      log.warn(
        `cold-start refresh rejected cross-realm personal session realm=${storedRealm} buildRegion=${AUTH_REGION}`,
      );
      return finishColdStartSignedOut('cold-start-incompatible-membership');
    }
    const previousSession = getActiveAppSession();
    await withCloudOwnerCommit({
      previousOwnerId: previousSession.dataOwnerId,
      nextOwnerId: refreshData.membership.id,
      prepareTransition: async () => {
        if (!accountSwitchTeardown) {
          throw new Error('cold-start cloud owner transition requires a teardown hook');
        }
        await accountSwitchTeardown({
          previousUserId: previousSession.dataOwnerId ?? previousSession.mode,
          nextUserId: refreshData.membership.id,
        });
        if (epochChanged('after-cold-start-teardown')) {
          throw new Error('cold-start cloud owner transition was superseded');
        }
      },
      prepareCommit: async () => {
        await claimLegacyNamespaceForVerifiedUser(refreshData.membership.id);
        if (epochChanged('after-owner-namespace-claim')) {
          throw new Error('cold-start cloud owner commit was superseded');
        }
      },
      commit: () => {
        const authRealmChanged = storedRealm !== activeAuthRealm;
        if (authRealmChanged) {
          activateClientEndpointRealm(storedRealm);
          activeAuthRealm = storedRealm;
        }
        accessToken = refreshData.accessToken;
        currentUser = mapMembershipToAuthUser(refreshData.membership);
        commitCloudAppSession(currentUser.id, authRealmChanged);
        persistedRefreshTokenNeedsIdentityCheck = false;
        clearReplacementIntegrationReloadTimers();
      },
    });
    await migrateLocalProviderBindingsAfterCloudCommit(refreshData.membership.id);
    // Schedule with the epoch this flow actually commits under (flowAuthEpoch, which
    // moves forward when the flow accepts its own startup-gate fallback) — passing the
    // original epochAtStart would make these tasks treat a recovery login as stale-auth
    // and skip the canary flag / org beta sync (PR #6273 review P2).
    scheduleCanaryFlagSync({
      token: refreshData.accessToken,
      expectedAuthEpoch: flowAuthEpoch,
      expectedUserId: refreshData.membership.id,
    });
    scheduleXdOrgBetaDefault({
      expectedAuthEpoch: flowAuthEpoch,
      expectedUserId: refreshData.membership.id,
    });
    scheduleRefresh(refreshData.accessToken);
    // XD / Mivo key 均为本地 only,不再在冷启动从服务器同步到本地。
    // 账号边界对账:换账号则清掉上一个账号留在本机的 provider key,同账号保留(不必重填)。
    getProviderSecretStore().reconcileOwner(refreshData.membership.id);
    // 自动登录(冷启动)也广播到 renderer,和 login() / refresh() / clearAuth() 一致。
    // AuthContext 是从 service.initialize() 的 IPC return value 拿初始 state 的,这条
    // 广播对它是"幂等的重复事件";但 renderer 侧晚到的订阅者(如 tapdb 上报)只能从
    // 广播拿到冷启动状态——不广播就永远收不到 auto-login 事件。
    notifyRenderer();
    notifyAuthListeners();
    return snapshotAuthState();
  } catch (err) {
    // 网络类失败都在 apiFetch 内部消化(返回 status 0),能走到这里的是 refresh 成功
    // **之后**的本地状态同步代码(writeSafe / provider owner reconcile 等)抛异常——
    // 此时新 refresh token 已轮换并落盘,删除它只会把有效凭据丢掉。保留 token、记录
    // 错误,本次以未登录返回,留待下次启动自愈。
    log.error(
      'cold-start auth initialize threw after refresh — keeping persisted refresh token',
      err,
    );
    // 迟到守卫③:异常清理同样不能覆盖用户手动登录后的状态。
    if (!epochChanged('catch')) {
      accessToken = null;
      currentUser = null;
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      resetActiveAuthRealmToBuild();
    }
    if (epochChanged('catch-return')) return snapshotAuthState();
    await finishColdStartSignedOut('cold-start-local-state-sync-failed');
    return snapshotLoggedOutAuthState();
  }
}

export async function refresh(options?: { serverRejectedToken?: boolean }): Promise<boolean> {
  if (getActiveAppSession().mode === 'local') {
    log.debug('runtime refresh skipped in local mode');
    return false;
  }
  // Cold-start recovery owns rotation until it settles. Runtime callers must
  // not consume the same saved refresh token concurrently, or wait indefinitely.
  if (coldStartAuthInFlight !== null && (!accessToken || !currentUser)) return false;
  // Explicit callers (including chat polling and resume) share the same wait
  // as the retry timer; skipped calls must not move the deadline forward.
  if (options?.serverRejectedToken && refreshBackoff.serverRejectedToken(authStateEpoch)) {
    scheduleRefreshRetry(authStateEpoch);
  }
  if (refreshPromise !== null) return refreshPromise;
  if (refreshBackoff.runtimeRemaining(authStateEpoch) > 0) return false;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  refreshBackoff.startRuntimeAttempt(authStateEpoch);
  refreshPromise = (async () => {
    const refreshEpoch = authStateEpoch;
    const refreshWasSuperseded = (point: string): boolean => {
      if (authStateEpoch === refreshEpoch) return false;
      log.warn(
        `runtime refresh superseded by logout or a newer login (${point}) — discarding late result`,
      );
      return true;
    };
    const persistedSession = readPersistedAuthSession();
    // #1687:成功读到持久会话 = 凭证库读取工作正常,连续失败计数清零;
    // 若此前已升级为 unavailable,立即广播恢复(banner 自动消失)。
    if (persistedSession !== null && credentialStoreHealth.noteRecovered()) {
      log.info('credential store recovered — clearing the persistent-unavailability state');
      notifyRenderer();
    }
    const refreshRealm = persistedSession?.realm ?? activeAuthRealm;
    if (persistedSession && persistedSession.realm !== activeAuthRealm) {
      try {
        await loadClientEndpointsForRealm(persistedSession.realm);
      } catch (error) {
        log.warn('runtime auth realm manifest unavailable; retrying later', error);
        scheduleRefreshRetryAfterTransientFailure(refreshEpoch);
        return false;
      }
    }
    const storedToken =
      persistedSession?.realm === refreshRealm ? persistedSession.refreshToken : null;
    if (!storedToken) {
      // 磁盘 refresh token 消失但本进程仍持有活会话:本进程内 logout 会同步清内存态
      // 并取消 refresh timer,冷启动 / 已登出时 currentUser 为 null —— 所以这个组合
      // 只会来自共享 userData 的外部实例登出 / 清凭证(同机互踢的一种)。按确定性
      // 失效走会话过期出口让用户明确感知;此前只打 debug 静默跳过,进程会进入
      // 「自以为登录、实际已死」的半死状态(模型源消失、device-link 无限 401)。
      if (currentUser !== null) {
        if (refreshWasSuperseded('missing-persisted-token')) return false;
        if (!isPersistedSecretAbsent(AUTH_SESSION_KEY)) {
          // 文件还在但读/解密失败(或加密暂不可用):瞬时故障,不能按凭证丢失
          // 强踢用户;保留会话,等下个 refresh 周期或 device-link 自救重试。
          log.warn(
            'runtime refresh: refresh token unreadable but file still present (or encryption unavailable) — treating as transient',
          );
          // #1687:单次仍按瞬时处理(绝不 expireRuntimeAuth),但连续跨过阈值后
          // 升级为持久凭证库故障并广播——此前这条路径无论失败多少轮都完全静默,
          // 用户面对的是假登录态 + 全部鉴权请求 401 而无任何可操作提示。
          if (credentialStoreHealth.noteReadFailure()) {
            log.warn(
              'credential store persistently unavailable — surfacing credentialStoreUnavailable to renderer',
            );
            notifyRenderer();
          }
          // 正常 refresh timer 已经触发过,这里不重排的话,一次密钥链/IO 抖动
          // 会让有效会话在 access token 到期前没有任何后续 refresh(半死)。
          scheduleRefreshRetryAfterTransientFailure(refreshEpoch);
          return false;
        }
        const previousUserId = currentUser.id;
        log.warn(
          'runtime refresh: persisted refresh token missing while session is live — expiring session (credential removed externally)',
        );
        await expireRuntimeAuth(previousUserId, 'credential-lost', {
          preservePersistedRefreshToken: true,
        });
        return false;
      }
      log.debug('runtime refresh skipped: no persisted refresh token');
      return false;
    }
    const diskTokenChangedBeforeRefresh =
      currentUser !== null &&
      lastAcceptedRefreshToken !== null &&
      storedToken !== lastAcceptedRefreshToken;
    if (diskTokenChangedBeforeRefresh) {
      log.warn(
        'runtime refresh detected refresh token changed on disk before request; will verify identity before accepting result',
      );
    }

    try {
      const { result, failureAction, replacementRetries, requestedToken } =
        await runAuthRefreshWithReplacementRetry(storedToken, {
          phase: 'runtime',
          realm: refreshRealm,
          withTransientRetry: false,
        });
      if (refreshWasSuperseded('after-refresh')) return false;
      const latestSession = readPersistedAuthSession();
      const stillOwnsRequestedSession =
        latestSession?.realm === refreshRealm && latestSession.refreshToken === requestedToken;
      if (!result.ok && !stillOwnsRequestedSession) {
        // Another shared-userData instance advanced the active session while
        // this request was in flight. Its failure cannot expire or delete the
        // newer owner, even when both accounts live in the same realm.
        log.warn('runtime auth session changed on disk; discarding stale refresh failure');
        scheduleRefreshRetryAfterTransientFailure(refreshEpoch);
        return false;
      }
      if (!result.ok) {
        const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
        const code = getRefreshErrorCode(result);
        if (action.kind === 'definitive-failure') {
          log.warn(
            `runtime refresh: definitive credential failure code=${code} — clearing auth, notifying session expired`,
          );
          const previousUserId =
            currentUser?.id ?? getActiveAppSession().dataOwnerId ?? 'signed-out';
          await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));
        } else if (action.kind === 'foreign-device') {
          log.warn(
            'runtime refresh: DEVICE_MISMATCH — expiring this process and keeping the persisted refresh token',
          );
          foreignDeviceLocalSignOut = true;
          const previousUserId =
            currentUser?.id ?? getActiveAppSession().dataOwnerId ?? 'signed-out';
          await expireRuntimeAuth(previousUserId, 'device-mismatch', {
            preservePersistedRefreshToken: true,
          });
        } else if (action.kind === 'replacement-retry') {
          log.warn(
            `runtime refresh failed for a stale token after replacement retries status=${result.status} code=${code ?? '<none>'} — scheduling retry`,
          );
          scheduleRefreshRetryAfterTransientFailure(refreshEpoch, result.retryAt, result.status === 0);
        } else {
          log.warn(
            `runtime refresh failed transiently status=${result.status} code=${code ?? '<none>'} — scheduling retry`,
          );
          scheduleRefreshRetryAfterTransientFailure(refreshEpoch, result.retryAt, result.status === 0);
        }
        return false;
      }

      const authRealmChanged = refreshRealm !== activeAuthRealm;
      const data = result.data as RefreshResponse;
      const credentialCommit = await commitDesktopRefreshCredentials(
        data,
        refreshRealm,
        requestedToken,
      );
      if (credentialCommit !== 'active') {
        log.warn(
          `runtime refresh lost active credential ownership (${credentialCommit}); preserved only the still-saved account token and will reconcile from disk`,
        );
        scheduleRefreshRetryAfterTransientFailure(refreshEpoch);
        return false;
      }
      lastAcceptedRefreshToken = data.refreshToken;
      if (!canRestoreAuthSessionForMembership(AUTH_REGION, refreshRealm, data.membership.kind)) {
        // The credential transaction above preserves the rotated token in its
        // issuing realm, but this process never publishes the incompatible
        // personal identity or activates that realm's business endpoints.
        log.warn(
          `runtime refresh rejected cross-realm personal session realm=${refreshRealm} buildRegion=${AUTH_REGION}`,
        );
        if (currentUser !== null) {
          await expireRuntimeAuth(currentUser.id, 'replaced-elsewhere', {
            preservePersistedRefreshToken: true,
          });
        } else {
          resetActiveAuthRealmToBuild();
          await recoverAccountFreeOwnerAtStartup('signed-out', 'runtime-incompatible-membership');
        }
        return false;
      }
      const needsIdentityCheck =
        replacementRetries > 0 ||
        persistedRefreshTokenNeedsIdentityCheck ||
        diskTokenChangedBeforeRefresh;
      if (needsIdentityCheck) {
        // The replacement token may have been written by another shared-userData
        // instance. Verify / reconcile the account before accepting its access token,
        // otherwise renderer state could still show account A while API calls use B.
        persistedRefreshTokenNeedsIdentityCheck = true;
        const previousUserId = currentUser?.id ?? null;
        const previousMembershipKind = currentUser?.membershipKind ?? null;
        const nextUser = mergeMembershipWithExisting(data.membership, currentUser);
        const accountSwitched = previousUserId !== null && previousUserId !== nextUser.id;
        const membershipKindChanged = previousMembershipKind !== nextUser.membershipKind;
        if (accountSwitched) {
          log.warn(
            `runtime replacement refresh switched authenticated user from ${previousUserId} to ${nextUser.id}; reconciling auth state`,
          );
        }
        await withCloudOwnerCommit({
          previousOwnerId: getActiveAppSession().dataOwnerId,
          nextOwnerId: nextUser.id,
          prepareTransition: async () => {
            if (!accountSwitchTeardown) {
              throw new Error('runtime cloud owner transition requires a teardown hook');
            }
            await accountSwitchTeardown({
              previousUserId: previousUserId ?? getActiveAppSession().mode,
              nextUserId: nextUser.id,
            });
            if (refreshWasSuperseded('after-account-switch-teardown')) {
              throw new Error('runtime cloud owner transition was superseded');
            }
          },
          prepareCommit: async () => {
            await claimLegacyNamespaceForVerifiedUser(nextUser.id);
            if (refreshWasSuperseded('after-owner-namespace-claim')) {
              throw new Error('runtime cloud owner commit was superseded');
            }
          },
          commit: () => {
            if (authRealmChanged) {
              activateClientEndpointRealm(refreshRealm);
              activeAuthRealm = refreshRealm;
            }
            accessToken = data.accessToken;
            currentUser = nextUser;
            commitCloudAppSession(currentUser.id, authRealmChanged);
          },
        });
        await migrateLocalProviderBindingsAfterCloudCommit(nextUser.id);
        persistedRefreshTokenNeedsIdentityCheck = false;
        getProviderSecretStore().reconcileOwner(nextUser.id);
        if (accountSwitched) {
          try {
            await clearPerAccountIntegrations();
            await reloadPerAccountIntegrationsFromDisk(accessToken);
          } catch (err) {
            log.error(
              'reload per-account integrations after replacement account switch failed',
              err,
            );
          }
          if (refreshWasSuperseded('after-integration-reload')) return false;
          scheduleReplacementIntegrationReloadRetries(nextUser.id);
        }
        scheduleCanaryFlagSync({
          token: data.accessToken,
          expectedAuthEpoch: refreshEpoch,
          expectedUserId: nextUser.id,
        });
        scheduleXdOrgBetaDefault({
          expectedAuthEpoch: refreshEpoch,
          expectedUserId: nextUser.id,
        });
        scheduleRefresh(data.accessToken);
        notifyAccessTokenRefreshed();
        notifyRenderer();
        if (previousUserId !== nextUser.id || authRealmChanged || membershipKindChanged) {
          notifyAuthListeners();
        }
        return true;
      }

      const previousMembershipKind = currentUser?.membershipKind ?? null;
      const nextUser = mergeMembershipWithExisting(data.membership, currentUser);
      const membershipKindChanged = previousMembershipKind !== nextUser.membershipKind;
      await withCloudOwnerCommit({
        previousOwnerId: getActiveAppSession().dataOwnerId,
        nextOwnerId: nextUser.id,
        prepareTransition: async () => {
          if (!accountSwitchTeardown) {
            throw new Error('runtime cloud owner transition requires a teardown hook');
          }
          await accountSwitchTeardown({
            previousUserId: getActiveAppSession().dataOwnerId ?? getActiveAppSession().mode,
            nextUserId: nextUser.id,
          });
        },
        commit: () => {
          if (authRealmChanged) {
            activateClientEndpointRealm(refreshRealm);
            activeAuthRealm = refreshRealm;
          }
          accessToken = data.accessToken;
          currentUser = nextUser;
          commitCloudAppSession(currentUser.id, authRealmChanged);
        },
      });
      await migrateLocalProviderBindingsAfterCloudCommit(nextUser.id);
      persistedRefreshTokenNeedsIdentityCheck = false;
      scheduleRefresh(data.accessToken);
      notifyAccessTokenRefreshed();
      notifyRenderer();
      if (authRealmChanged || membershipKindChanged) {
        notifyAuthListeners();
      }
      return true;
    } catch (err) {
      if (refreshWasSuperseded('catch')) return false;
      // apiFetch 消化了网络错误(status 0 走上面 !ok 分支),这里是本地状态同步异常;
      // 与瞬时失败同等对待:记录并重排,避免刷新链就此断掉。
      log.error('runtime refresh threw — retrying later', err);
      scheduleRefreshRetryAfterTransientFailure(refreshEpoch);
      return false;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * Called on system resume (powerMonitor 'resume' event).
 * If the app JWT is expired or expiring within 5 minutes, trigger a refresh.
 */
export function handleResume(): void {
  if (accessToken === null) return;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString('utf-8'));
    if (payload.exp * 1000 - Date.now() <= 5 * 60 * 1000) {
      refresh();
    }
  } catch {
    // Invalid JWT format — skip
  }
}

export function dispose(): void {
  stopColdStartRecovery();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  clearReplacementIntegrationReloadTimers();
}
