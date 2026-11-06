import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';
import { AuthApiError, retryAfterDeadline } from '@cindy/auth-client';
import { runRefreshWithReplacementRetry } from '../authRefreshFailure';
import {
  awaitWithStartupTimeout,
  resolveColdStartTimeoutRecovery,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
} from '../authStartupGate';

// Test value (unit): execute the production cold-start and refresh entrypoints with
// in-memory credentials/network. On 2026-10-29 three DNS failures stranded a valid login;
// the pure startup-gate tests did not exercise ongoing retries.
// Minimal input: a saved session, repeated status=0 responses, then recovery.
// Compile once; never load Electron, a real credential store, or sleep in wall-clock time.
const source = ts.createSourceFile(
  'authManager.ts',
  readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'apiFetch',
  'commitDesktopRefreshCredentials',
  'writeResourceSessionToVault',
  'initialize',
  'refresh',
  'scheduleRefresh',
  'scheduleRefreshRetry',
  'scheduleRefreshRetryAfterTransientFailure',
  'getRefreshErrorCode',
  'runColdStartRefreshFlow',
  'runAuthRefreshWithReplacementRetry',
  'waitForColdStartRetry',
  'stopColdStartRecovery',
]);
const compiled = ts.transpileModule(
  `
let authStateEpoch = 0, accessToken = null, currentUser = null;
let activeAuthRealm = 'global';
let coldStartAuthInFlight = null, coldStartRetryWait = null, refreshTimer = null;
let coldStartRecoveryStopped = false, coldStartRetryState = null;
let lastAcceptedRefreshToken = null, persistedRefreshTokenNeedsIdentityCheck = false;
let foreignDeviceLocalSignOut = false;
let refreshPromise = null;
const refreshBackoff = new AuthRefreshBackoff();
const passiveLocalSignOut = false;
const API_FETCH_TIMEOUT_MS = 15000;
const AUTH_REGION = 'global';
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20000;
const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'legacy-resource';
const LEGACY_REFRESH_TOKEN_KEY = 'legacy', LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'legacy-account';
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250];
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000];
const credentialStoreHealth = { unavailable: false, noteRecovered() {} };
const coldStartTimeoutFallbacks = new ColdStartAuthFallbackRegistry();
const snapshotAuthState = () => ({ isAuthenticated: !!accessToken, user: currentUser });
const snapshotLoggedOutAuthState = snapshotAuthState;
const readPersistedAuthSession = () => saved.session;
const readStoredRefreshTokenCandidates = () => [saved.session?.refreshToken];
const hasPotentiallyPersistedAuthCredentials = () => !!saved.session;
const finishColdStartSignedOut = async () => snapshotAuthState();
const recoverAccountFreeOwnerAtStartup = async () => {
  onStartupFallback();
  coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1);
  authStateEpoch++;
};
const reconcileDesktopActiveAuthSession = async () => saved.session;
${source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(source).replace(/^export /, ''))
  .join('\n')}
return {
  fetch: apiFetch, start: initialize, runtimeRefresh: refresh,
  state: snapshotAuthState,
  activateRuntime: () => { accessToken = 'test-expired'; currentUser = { id: 'original' }; },
  backoff: refreshBackoff,
  fallback: () => { coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1); authStateEpoch++; },
  changeOwner: () => {
    authStateEpoch++; accessToken = 'test-new-login'; currentUser = { id: 'other' };
    saved.session = { version: 1, realm: 'global', refreshToken: 'other-refresh' };
    vault.activeAccountKey = 'global:other';
    vault.resources['global:other'] = { realm: 'global', refreshToken: 'other-refresh' };
  },
  stop: stopColdStartRecovery,
  logoutForTest: () => { stopColdStartRecovery(); authStateEpoch++; saved.session = null;
    vault.resources = {}; vault.activeAccountKey = null; vault.signedOutAt = Date.now(); },
};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup(random = 0) {
  const saved: { session: any } = {
    session: { version: 1, realm: 'global', refreshToken: 'test-refresh' },
  };
  const membership = { id: 'original', kind: 'personal', passportId: 'passport-original' };
  const vault: any = {
    activeAccountKey: 'global:original',
    resources: { 'global:original': { realm: 'global', refreshToken: 'test-refresh' } },
  };
  const ok = {
    ok: true,
    status: 200,
    data: { accessToken: 'test-access', refreshToken: 'test-rotated', membership },
  };
  const request = vi
    .fn<(...args: unknown[]) => Promise<any>>()
    .mockResolvedValue({ ok: false, status: 0, data: null });
  const transaction = vi.fn(async (mutate: any, afterPersist: any) => {
    const result = mutate(vault);
    await afterPersist(result);
    return result;
  });
  const clear = vi.fn(async () => {
    saved.session.refreshToken = '';
  });
  const deps = {
    saved,
    vault,
    onStartupFallback: vi.fn(),
    transactAuthAccountVault: transaction,
    accountVaultKey: (realm: string, id: string) => `${realm}:${id}`,
    loggedOutAccountKeySet: () => new Set(),
    readSafe: () => null,
    writePersistedAuthSessionOrThrow: (refreshToken: string, realm: string) => {
      saved.session = { version: 1, realm, refreshToken };
    },
    metadataFromMembership: (membership: unknown) => membership,
    AuthRefreshBackoff: class extends AuthRefreshBackoff {
      constructor() {
        super(
          () => Date.now(),
          () => random,
        );
      }
    },
    AuthApiError,
    retryAfterDeadline,
    authServerUrl: () => 'https://auth.example.invalid',
    net: { fetch: vi.fn() },
    requestErrorMessage: String,
    ColdStartAuthFallbackRegistry,
    commitColdStartRefreshIfCurrent,
    awaitWithStartupTimeout,
    resolveColdStartTimeoutRecovery,
    readReloginFlag: () => null,
    removeSafe: vi.fn(),
    isOwnerChangeShellPending: () => false,
    ownerChangeShellGate: { isPending: () => false },
    runRefreshWithReplacementRetry,
    requestAuthRefresh: request,
    loadClientEndpointsForRealm: vi.fn(async () => {}),
    createAuthClient: () => ({ discover: vi.fn() }),
    log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    readActiveVaultRefreshCandidate: () => null,
    clearConfirmedDeadRefreshTokens: clear,
    resetActiveAuthRealmToBuild: vi.fn(),
    isPassiveSharedUserDataInstance: () => false,
    canRestoreAuthSessionForMembership: () => true,
    getActiveAppSession: () => ({ mode: 'signed-out', dataOwnerId: null }),
    withCloudOwnerCommit: async (options: any) => {
      await options.prepareTransition();
      await options.prepareCommit?.();
      options.commit();
    },
    accountSwitchTeardown: vi.fn(async () => {}),
    claimLegacyNamespaceForVerifiedUser: vi.fn(async () => {}),
    mapMembershipToAuthUser: (value: unknown) => value,
    commitCloudAppSession: vi.fn(),
    clearReplacementIntegrationReloadTimers: vi.fn(),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    scheduleCanaryFlagSync: vi.fn(),
    scheduleXdOrgBetaDefault: vi.fn(),
    notifyAccessTokenRefreshed: vi.fn(),
    mergeMembershipWithExisting: (membership: unknown) => membership,
    getProviderSecretStore: () => ({ reconcileOwner: vi.fn() }),
    notifyRenderer: vi.fn(),
    notifyAuthListeners: vi.fn(),
  };
  const main = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { ...main, saved, vault, request, ok, transaction, clear, deps };
}

describe('saved login recovery after startup network failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps slowly retrying beyond three failures and restores the original account after the startup fallback', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ isAuthenticated: false });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.request.mock.calls.length).toBeGreaterThan(3);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.deps.notifyAuthListeners).toHaveBeenCalled();
  });

  it('preserves only the old saved account rotation after an owner change', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.changeOwner();
    resolve(h.ok);
    await expect(pending).resolves.toMatchObject({ user: { id: 'other' } });
    expect(h.saved.session.refreshToken).toBe('other-refresh');
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-rotated');
    expect(h.vault.activeAccountKey).toBe('global:other');
    expect(h.deps.notifyAuthListeners).not.toHaveBeenCalled();
  });

  // PR #7737: stopping publication must not lose a rotating request's result or
  // its server deadline. Existing tests only stopped a timer or changed owner.
  // Minimal sequences below execute initialize with an in-flight reply (unit).
  it.each(['logout', 'newer-token'])(
    'does not resurrect or overwrite credentials after %s',
    async (change) => {
      const h = setup();
      let resolve!: (value: unknown) => void;
      h.request.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const pending = h.start();
      await vi.advanceTimersByTimeAsync(0);
      if (change === 'logout') h.logoutForTest();
      else {
        h.stop();
        h.saved.session.refreshToken = 'newer-refresh';
        h.vault.resources['global:original'].refreshToken = 'newer-refresh';
      }
      resolve(h.ok);
      await pending;
      expect(h.saved.session?.refreshToken).toBe(change === 'logout' ? undefined : 'newer-refresh');
      expect(h.vault.resources['global:original']?.refreshToken).toBe(
        change === 'logout' ? undefined : 'newer-refresh',
      );
    },
  );

  // PR #7737 replacement-token regression (unit): existing deadline tests keep
  // the same token. initialize must retain both Retry-After and failure history
  // when A fails, another instance writes B, and the replacement request is limited.
  it('keeps replacement-token backoff', async () => {
    const h = setup(0.5);
    h.request
      .mockResolvedValueOnce({ ok: false, status: 503, data: {} })
      .mockImplementationOnce(async () => {
        h.saved.session.refreshToken = 'test-replacement';
        h.vault.resources['global:original'].refreshToken = 'test-replacement';
        return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
      })
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 429,
        data: {},
        retryAt: Date.now() + 240_000,
      }))
      .mockResolvedValue(h.ok);
    void h.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh',
      'test-refresh',
      'test-replacement',
    ]);
    // The second failure adds 60s of jitter after the 240s server deadline.
    // Resetting the failure count would retry 30s early; retaining A's key retries now.
    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.saved.session.refreshToken).toBe('test-replacement');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenLastCalledWith('test-replacement', 'global');
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('retries endpoint discovery without sending the credential to a fallback realm', async () => {
    const h = setup();
    h.deps.loadClientEndpointsForRealm.mockRejectedValue(new Error('offline'));
    void h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).not.toHaveBeenCalled();
    h.deps.loadClientEndpointsForRealm.mockResolvedValue();
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true });
  });

  it.each(['REFRESH_TOKEN_EXPIRED', 'DEVICE_MISMATCH'])(
    'stops after terminal response %s',
    async (code) => {
      const h = setup();
      h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code } } });
      await expect(h.start()).resolves.toMatchObject({ isAuthenticated: false });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.clear).toHaveBeenCalledTimes(code === 'REFRESH_TOKEN_EXPIRED' ? 1 : 0);
    },
  );
});

// Unit regression: runtime refresh + its real timer must recover within 3 seconds
// after three transport failures and a trusted 401 (2026-11-04 outage). Existing
// cold-start tests and admission-only backoff tests never ran this timer path.
// Each quick attempt now needs evidence received after the previous launch;
// without it the original long deadline must resume (2026-11-04 follow-up).
describe('runtime token rejection after an offline backoff', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('requires fresh 401 evidence for every quick attempt and retains its tier across an offline wait', async () => {
    const h = setup(0.5);
    h.activateRuntime();
    await h.runtimeRefresh();
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    const longDeadline = Date.now() + h.backoff.remaining(0);
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 4; i++) await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(Date.now() + h.backoff.remaining(0)).toBe(longDeadline);

    // No new evidence: the timer returns to the original long deadline, even
    // though the quick tier's earliest retry time has already passed.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(Date.now() + h.backoff.runtimeRemaining(0)).toBe(longDeadline);
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.request).toHaveBeenCalledTimes(5);
    expect(Date.now() + h.backoff.remaining(0)).toBe(longDeadline);

    let finish!: (result: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.runtimeRefresh({ serverRejectedToken: true });
    // Tier retained across the 65s outage: the next floor is 3s, not 1.5s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.request).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.request).toHaveBeenCalledTimes(6);
    // Evidence received after launch (even while in flight) may authorize the
    // following attempt, but never a concurrent request or a second deadline.
    const concurrent = [h.runtimeRefresh(), h.runtimeRefresh({ serverRejectedToken: true })];
    finish({ ok: false, status: 0, data: null });
    await expect(Promise.all(concurrent)).resolves.toEqual([false, false]);
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.request).toHaveBeenCalledTimes(7);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.backoff.remaining(0)).toBe(0);
    expect(h.deps.notifyAccessTokenRefreshed).toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it.each([503, 0])('keeps Retry-After despite 401s after leaving the quick retry path (status=%s)', async status => {
    const h = setup(0.5);
    h.activateRuntime();
    await h.runtimeRefresh();
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_500); // One quick transport failure.
    const retryAt = Date.now() + 600_000;
    h.request.mockResolvedValue({ ok: false, status, retryAt, data: null });
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(2_250);
    expect(h.request).toHaveBeenCalledTimes(3);
    // The failed quick request consumes only the next long tier (2–4m).
    const deadline = retryAt + 60_000;
    expect(Date.now() + h.backoff.remaining(0)).toBe(deadline);
    for (let i = 0; i < 5; i++) await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
    expect(h.request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(4);
  });
});
