// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ColdStartAuthFallbackRegistry, commitColdStartRefreshIfCurrent } from '../authStartupGate';

/** Regression guard for login progress that is intentionally owned by Electron main. */
describe('auth login-flow reset', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const logoutPolicySource = readFileSync(
    resolve(process.cwd(), 'src/main/authAccountLogoutPolicy.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const deviceLinkSource = readFileSync(
    resolve(process.cwd(), 'src/main/device-link/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const hookControlSource = readFileSync(
    resolve(process.cwd(), 'src/main/hook-control/ipc.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('filters invalid vault children only for read-only projection', () => {
    const readStart = source.indexOf('function readAuthAccountVault(');
    const readEnd = source.indexOf('\n}\n\nfunction writeAuthAccountVault', readStart);
    const readBody = source.slice(readStart, readEnd);

    expect(readBody).toContain('if (options.allowUnreadable || options.recoverInvalid) continue;');
    expect(readBody).toContain("throw new Error('invalid saved resource credential')");
    expect(readBody).toContain("throw new Error('invalid saved Passport credential')");
    expect(readBody).toContain("throw new Error('invalid saved Passport membership')");
    expect(readBody).toContain("throw new Error('invalid logged-out account key')");
    expect(readBody).toContain('memberships.length !== item.memberships.length');
    expect(readBody).toContain('allowUnreadableLogoutTombstones?: boolean');
    expect(readBody).toContain('if (options.allowUnreadableLogoutTombstones) {');
    expect(readBody).toContain(
      'active && resources[active] && !loggedOutKeys.has(active) ? active : null',
    );
  });

  it('replaces unreadable logout tombstones only for explicit login or logout', () => {
    const writeStart = source.indexOf('function writeAuthAccountVault(');
    const writeEnd = source.indexOf('\n}\n\nfunction writeAuthAccountVaultOrThrow', writeStart);
    const writeBody = source.slice(writeStart, writeEnd);
    expect(writeBody).toContain('replaceUnreadableLogoutTombstones?: boolean');
    expect(writeBody).toContain('const previousLogoutUnreadable =');
    expect(writeBody).toContain('previousLogoutCiphertext === null');
    expect(writeBody).toContain('!options.replaceUnreadableLogoutTombstones');
    expect(writeBody).toContain(
      'writeAtomicSafeCiphertext(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, previousLogoutCiphertext)',
    );

    const clearStart = source.indexOf('async function clearAuthAccountVault(');
    const clearEnd = source.indexOf('\n}\n\nfunction metadataFromMembership', clearStart);
    expect(source.slice(clearStart, clearEnd)).toContain(
      'writeAuthAccountVaultOrThrow(vault, { replaceUnreadableLogoutTombstones: true });',
    );
  });

  it('atomically replaces the aggregate saved-account vault', () => {
    const writeStart = source.indexOf('function writeAtomicSafe(');
    const writeEnd = source.indexOf('\n}\n\nfunction removeAtomicSafeOrThrow', writeStart);
    const writeBody = source.slice(writeStart, writeEnd);
    expect(writeBody).toContain('atomicWriteFileSync(');
    expect(writeBody).toContain("safeStorage.encryptString(value).toString('base64')");

    const readStart = source.indexOf('function readAtomicSafe(');
    const readEnd = source.indexOf('\n}\n\nfunction isAtomicPersistedSecretAbsent', readStart);
    expect(source.slice(readStart, readEnd)).toContain('fs.readFileSync(`${filepath}.bak`');

    const clearStart = source.indexOf('function removeAtomicSafeOrThrow(');
    const clearEnd = source.indexOf('\n}\n\nfunction removeSafe(', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody.indexOf('`${filepath}.bak`')).toBeLessThan(clearBody.indexOf('filepath])'));
  });

  it('keeps account refresh out of resource-token cold-start initialization', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const authenticatedFastPath = initializeBody.indexOf('if (accessToken && currentUser)');

    expect(authenticatedFastPath).toBeGreaterThan(-1);
    expect(initializeBody).toContain('removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);');
    expect(initializeBody).not.toContain('refreshAccount');
    expect(initializeBody).not.toContain('restoreAccountSelection');
  });

  it('returns a committed local session before reading or refreshing cloud credentials', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const localGuard = initializeBody.indexOf("getActiveAppSession().mode === 'local'");
    const refreshTokenRead = initializeBody.indexOf('await reconcileDesktopActiveAuthSession()');

    expect(localGuard).toBeGreaterThan(-1);
    expect(refreshTokenRead).toBeGreaterThan(localGuard);
    expect(initializeBody.slice(localGuard, refreshTokenRead)).toContain(
      'return snapshotAuthState();',
    );
  });

  it('activates a restored realm only after the refreshed membership passes build policy', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    expect(initializeBody).not.toContain('activateClientEndpointRealm(persistedSession.realm);');

    const coldStart = source.indexOf('async function runColdStartRefreshFlow(');
    const coldEnd = source.indexOf('\n}\n\nasync function loadLoginProviders()', coldStart);
    const coldBody = source.slice(coldStart, coldEnd);
    // Endpoint discovery now runs inside the recoverable flow, still before any
    // credential request or realm activation (cross-realm credential boundary).
    expect(coldBody.indexOf('await loadClientEndpointsForRealm(storedRealm);')).toBeLessThan(
      coldBody.indexOf('await runAuthRefreshWithReplacementRetry(storedToken,'),
    );
    const coldCredentialCommit = coldBody.indexOf('await commitDesktopRefreshCredentials(');
    const coldPolicyGuard = coldBody.indexOf('!canRestoreAuthSessionForMembership(');
    const coldRealmActivation = coldBody.indexOf('activateClientEndpointRealm(storedRealm);');
    expect(coldCredentialCommit).toBeGreaterThan(-1);
    expect(coldPolicyGuard).toBeGreaterThan(-1);
    expect(coldCredentialCommit).toBeLessThan(coldPolicyGuard);
    expect(coldRealmActivation).toBeGreaterThan(coldPolicyGuard);
    expect(coldBody).toContain('requestedToken,');
    expect(coldBody).toContain('allowUnclaimedVault: true');
    // Token rotation is durable before publication checks; stopping the UI must
    // not lose the consumed credential. Ownership remains checked in the vault.
    expect(coldBody.indexOf("epochChanged('after-cold-start-credential-commit')")).toBeGreaterThan(
      coldCredentialCommit,
    );
    expect(coldBody).toContain("credentialCommit !== 'active'");
    const inactiveCommit = coldBody.indexOf("credentialCommit !== 'active'");
    const activeCandidateRead = coldBody.indexOf(
      'readActiveVaultRefreshCandidate()',
      inactiveCommit,
    );
    const ownershipRetry = coldBody.indexOf('return runColdStartRefreshFlow(', activeCandidateRead);
    expect(activeCandidateRead).toBeGreaterThan(inactiveCommit);
    expect(ownershipRetry).toBeGreaterThan(activeCandidateRead);
    expect(coldBody.slice(inactiveCommit, ownershipRetry)).toContain(
      '!attemptedOwnershipTokens.has(nextActiveCandidate.refreshToken)',
    );
    expect(coldBody).not.toContain(
      'writePersistedAuthSession(refreshData.refreshToken, storedRealm)',
    );
    expect(coldBody).not.toContain('rememberResourceSession(refreshData');

    const refreshStart = source.indexOf('export async function refresh(');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    const runtimePolicyGuard = refreshBody.indexOf('!canRestoreAuthSessionForMembership(');
    const runtimeRealmActivation = refreshBody.indexOf(
      'activateClientEndpointRealm(refreshRealm);',
    );
    expect(runtimePolicyGuard).toBeGreaterThan(-1);
    expect(runtimeRealmActivation).toBeGreaterThan(runtimePolicyGuard);
    expect(refreshBody).toContain('await commitDesktopRefreshCredentials(');
    expect(refreshBody).toContain(
      "await expireRuntimeAuth(currentUser.id, 'replaced-elsewhere', {",
    );
    expect(refreshBody).toContain('preservePersistedRefreshToken: true');
  });

  it('retries the vault active account after a stale compatibility token fails on cold start', () => {
    const coldStart = source.indexOf('async function runColdStartRefreshFlow(');
    const coldStartEnd = source.indexOf('\n}\n\n/**\n * Called on system resume', coldStart);
    const coldStartBody = source.slice(coldStart, coldStartEnd);
    expect(coldStartBody).toContain(
      'const nextActiveCandidate = readActiveVaultRefreshCandidate();',
    );
    expect(coldStartBody).toContain(
      'cold-start refresh rejected a stale compatibility token; continuing with the vault active account',
    );
    expect(coldStartBody).toContain(
      'expectedActiveVaultAccountKey: nextActiveCandidate.accountKey',
    );
    const clearDeadTokens = coldStartBody.indexOf('await clearConfirmedDeadRefreshTokens(');
    const staleEpochGuard = coldStartBody.indexOf(
      "epochChanged('after-clearing-confirmed-dead-tokens')",
      clearDeadTokens,
    );
    const ownershipRetry = coldStartBody.indexOf(
      'return runColdStartRefreshFlow(',
      clearDeadTokens,
    );
    expect(clearDeadTokens).toBeGreaterThan(-1);
    expect(staleEpochGuard).toBeGreaterThan(clearDeadTokens);
    expect(ownershipRetry).toBeGreaterThan(staleEpochGuard);
  });

  it('does not wait on an unbounded owner transition before signed-out recovery', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const timeoutRecovery = initializeBody.indexOf(
      "recoverAccountFreeOwnerAtStartup('signed-out', 'cold-start-timeout-recovery'",
    );
    expect(timeoutRecovery).toBeGreaterThan(-1);
    // The timeout boundary must go through the guarded helper so a still-pending
    // owner transition is not awaited (its teardown awaits are unbounded) and no
    // competing signed-out cleanup starts underneath it.
    const guardedRecovery = initializeBody.lastIndexOf(
      'resolveColdStartTimeoutRecovery({',
      timeoutRecovery,
    );
    expect(guardedRecovery).toBeGreaterThan(-1);
    expect(guardedRecovery).toBeLessThan(timeoutRecovery);
    expect(initializeBody).toContain('pendingState: snapshotLoggedOutAuthState(true)');
    expect(initializeBody).toContain('timeoutStartEpoch: startupTimeoutEpoch');
    expect(initializeBody).toContain('currentEpoch: authStateEpoch');
    expect(initializeBody).toContain('currentState: snapshotAuthState()');
    expect(initializeBody).not.toContain(
      'await ownerChangeShellGate.waitForSettled();\n        return snapshotAuthState();',
    );
    // The fallback must tell the recovery it is the startup-gate fallback, so the
    // epoch it raises is recorded at the moment it is raised (see below).
    expect(
      initializeBody.indexOf('coldStartTimeoutRecovery: true', timeoutRecovery),
    ).toBeGreaterThan(timeoutRecovery);
  });

  it('accepts a late refresh when the fallback edge was recorded at bump time', () => {
    // Behavior equivalent of "record where the epoch is bumped": an edge that is
    // recorded before the refresh settles lets the late success commit; a chain
    // with a missing edge (bump recorded too late / by a real auth action) does not.
    const registry = new ColdStartAuthFallbackRegistry();
    registry.record(3, 4);
    const committed = commitColdStartRefreshIfCurrent({
      registry,
      flowEpoch: 3,
      currentEpoch: 4,
      commit: () => 'owner',
    });
    expect(committed).toEqual({ superseded: false, flowEpoch: 4, value: 'owner' });

    const unrecorded = new ColdStartAuthFallbackRegistry();
    expect(
      commitColdStartRefreshIfCurrent({
        registry: unrecorded,
        flowEpoch: 3,
        currentEpoch: 4,
        commit: () => 'owner',
      }),
    ).toEqual({ superseded: true });
  });

  it('drops a runtime refresh result after logout or a newer login changes auth generation', () => {
    const refreshStart = source.indexOf('export async function refresh(');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain('const refreshEpoch = authStateEpoch;');
    expect(refreshBody).toContain("refreshWasSuperseded('after-refresh')");
    // 'after-product-me' 守卫点已随产品 /api/user/me 退役(2026-07):refresh
    // 与提交之间不再有产品资料网络往返,该迟到窗口不存在了。
    expect(refreshBody).not.toContain('/api/user/me');
    expect(refreshBody).toContain("refreshWasSuperseded('after-account-switch-teardown')");
    expect(refreshBody).toContain("refreshWasSuperseded('after-integration-reload')");
    expect(refreshBody).toContain("refreshWasSuperseded('catch')");
    expect(refreshBody).toContain('latestSession.refreshToken === requestedToken');
    expect(refreshBody).toContain("credentialCommit !== 'active'");

    const helperStart = source.indexOf('async function commitDesktopRefreshCredentials(');
    const helperEnd = source.indexOf('\n}\n\n/** Persist a rotated Passport', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('vault.activeAccountKey === key');
    expect(helperBody).toContain('options.validateBeforeWrite?.()');
    expect(helperBody).toContain('canClaimUninitializedVault');
    expect(helperBody).toContain('Object.keys(vault.resources).length === 0');
    expect(helperBody).toContain('readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)');
    expect(helperBody).toContain('markActive: stillOwnsActiveSession');
    expect(helperBody).toContain("if (commit === 'active') {");
    expect(helperBody).toContain('writePersistedAuthSessionOrThrow(pair.refreshToken, realm);');
  });

  it('reconnects realm-bound main clients after a runtime realm change commits its new token', () => {
    const refreshStart = source.indexOf('export async function refresh(');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);

    expect(refreshBody).toContain('const authRealmChanged = refreshRealm !== activeAuthRealm;');
    expect(refreshBody).toContain('await commitDesktopRefreshCredentials(');
    expect(refreshBody).toContain('activeAuthRealm = refreshRealm;');
    expect(
      refreshBody.match(/commitCloudAppSession\(currentUser.id, authRealmChanged\);/g),
    ).toHaveLength(2);
    expect(refreshBody).toContain(
      'const membershipKindChanged = previousMembershipKind !== nextUser.membershipKind;',
    );
    expect(refreshBody).toContain(
      'previousUserId !== nextUser.id || authRealmChanged || membershipKindChanged',
    );
    expect(refreshBody).toContain(
      'if (authRealmChanged || membershipKindChanged) {\n        notifyAuthListeners();',
    );

    expect(deviceLinkSource).toContain('restartDeviceLinkForAuthRealmChange();');
    expect(deviceLinkSource).toContain('void stopArbitrationAndTeardown()');
    expect(deviceLinkSource).toContain('authManager.getActiveAuthRealm() !== targetRealm');
    expect(hookControlSource).toContain('} else if (realmChanged) {');
    expect(hookControlSource).toContain('manager?.sync();');
  });

  it('tears down the owner boundary before notifying runtime auth expiry', () => {
    const helperStart = source.indexOf('async function expireRuntimeAuth(');
    const helperEnd = source.indexOf('\n}\n\n// ── Public API', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('clearAuth({ notify: false,');
    expect(helperBody).toContain('await withAccountFreeOwnerCommit({');
    expect(helperBody).toContain('authAlreadyCleared: true');
    expect(helperBody).toContain('notifySessionExpired(reason);');

    const ownerCommitStart = source.indexOf('async function withAccountFreeOwnerCommit(');
    const ownerCommitEnd = source.indexOf(
      '\n}\n\nasync function withCloudOwnerCommit(',
      ownerCommitStart,
    );
    const ownerCommitBody = source.slice(ownerCommitStart, ownerCommitEnd);
    expect(ownerCommitBody).toContain('beginAppSessionBoundary()');
    expect(ownerCommitBody).toContain('notifyRendererAuthBoundaryPending();');
    expect(ownerCommitBody).toContain('await accountSwitchTeardown');
    expect(ownerCommitBody).toContain('await authSessionTeardown(opts.reason);');
    expect(ownerCommitBody).toContain('notifyAuthListeners();');

    const refreshStart = source.indexOf('export async function refresh(');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain(
      'await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));',
    );
    expect(refreshBody).not.toContain('clearAuth({ notify: false });');
  });

  it('reserves local namespaces before publishing a cloud owner', () => {
    const cloudStart = source.indexOf('async function withCloudOwnerCommit(');
    const prepareStart = source.indexOf('prepareCommit: async () => {', cloudStart);
    const prepareEnd = source.indexOf('\n      },\n      commit: async () => {', prepareStart);
    const prepareBody = source.slice(prepareStart, prepareEnd);

    expect(prepareBody).toContain(
      'rollbackReservation = reserveCloudOwnerData(opts.nextOwnerId, opts.previousOwnerId);',
    );
    expect(prepareBody.indexOf('reserveCloudOwnerData')).toBeLessThan(
      prepareBody.indexOf('await opts.prepareCommit?.();'),
    );
    expect(source).toContain('await repairStableCloudOwnerDataReservations(currentUser.id);');
    expect(source).toContain('if (reservation && !reservation.finalize())');
    expect(source).toContain('if (!reservation.rollback())');
    expect(source).toContain('if (boundaryCommitApplied || commitApplied) return;');

    const failureStart = source.indexOf(
      'onCommitFailure: ({ commitApplied: boundaryCommitApplied }) => {',
      cloudStart,
    );
    const failureEnd = source.indexOf('\n      },\n    });', failureStart);
    const failureBody = source.slice(failureStart, failureEnd);
    expect(failureBody).toContain('if (boundaryCommitApplied || commitApplied) return;');
    expect(failureBody.indexOf('if (!reservation.rollback())')).toBeLessThan(
      failureBody.indexOf('rollbackReservation = null;'),
    );
    const finallyStart = source.indexOf('  } finally {', failureEnd);
    const finallyBody = source.slice(finallyStart, source.indexOf('\n  }\n', finallyStart));
    expect(finallyBody).toContain('if (!committed && !commitApplied)');

    const repairStart = source.indexOf(
      'function repairStableCloudOwnerDataReservationsWhileLocked(',
    );
    const repairEnd = source.indexOf(
      '\n}\n\nasync function repairStableCloudOwnerDataReservations(',
      repairStart,
    );
    const repairBody = source.slice(repairStart, repairEnd);
    expect(repairBody).toContain('reserveCommittedLocalProfileDataOwnerDetailed(');
    expect(repairBody).toContain(
      'const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);',
    );
    expect(repairBody).toContain(
      'reserveCommittedLocalProfileDataOwnerDetailed(\n      profileReservationOwnerId,',
    );
    expect(repairBody).toContain(
      'reserveCommittedLegacyNativeProviderAuthOwner(authoritativeOwnerId)',
    );
    expect(repairBody).not.toContain('reserveLocalProfileDataOwnerDetailed(');
    expect(repairBody).not.toContain('reserveLegacyNativeProviderAuthOwnerDetailed(ownerId)');
    expect(repairBody).toContain('remains authenticated with local adoption fail-closed');
    expect(repairBody).not.toContain('throw new Error');
    const serializedRepairStart = source.indexOf(
      'async function repairStableCloudOwnerDataReservations(',
    );
    const serializedRepairEnd = source.indexOf(
      '\n}\n\nfunction commitCloudAppSession(',
      serializedRepairStart,
    );
    const serializedRepairBody = source.slice(serializedRepairStart, serializedRepairEnd);
    expect(serializedRepairBody).toContain('withStableOwnerBoundaryMutation(ownerId');
    expect(serializedRepairBody).toContain(
      'repairStableCloudOwnerDataReservationsWhileLocked(ownerId)',
    );

    const reserveStart = source.indexOf('function reserveCloudOwnerData(');
    const reserveEnd = source.indexOf(
      '\n}\n\nfunction repairStableCloudOwnerDataReservationsWhileLocked(',
      reserveStart,
    );
    const reserveBody = source.slice(reserveStart, reserveEnd);
    expect(reserveBody).toContain(
      'const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);',
    );
    expect(reserveBody).toContain(
      'reserveLocalProfileDataOwnerDetailed(\n      profileReservationOwnerId,',
    );
    expect(reserveBody).toContain(
      'releaseLocalProfileDataOwner(\n          profileReservationOwnerId,',
    );
    expect(reserveBody).toContain(
      "if (nativeReservation.status === 'claimed' && nativeReservation.claimToken)",
    );
    expect(reserveBody).not.toContain(
      "profileReservation.status === 'claimed' &&\n      nativeReservation.status === 'claimed'",
    );
    expect(reserveBody).toContain('const authoritativeOwnerId = profileReservation.ownerId;');
    expect(reserveBody).toContain(
      'reserveLegacyNativeProviderAuthOwnerDetailed(authoritativeOwnerId)',
    );
    expect(reserveBody).toContain(
      "throw new Error('local profile and native provider ownership reservations disagree')",
    );
    expect(reserveBody).toContain(
      'finalize: () => recoverCloudOwnerDataReservations(authoritativeOwnerId)',
    );

    const migrationStart = source.indexOf(
      'async function migrateLocalProviderBindingsAfterCloudCommit(ownerId: string): Promise<void> {',
    );
    const migrationEnd = source.indexOf(
      '\n}\n\nasync function finishColdStartSignedOut(',
      migrationStart,
    );
    const migrationBody = source.slice(migrationStart, migrationEnd);
    expect(migrationBody).toContain(
      'if (!(await repairStableCloudOwnerDataReservations(ownerId))) return;',
    );
    expect(migrationBody.indexOf('repairStableCloudOwnerDataReservations')).toBeLessThan(
      migrationBody.indexOf('migrateLocalNativeProviderAuthBindings'),
    );
  });

  it('synchronizes canary flags on every path that establishes a new auth identity', () => {
    expect(source).not.toContain('canaryFlagStore.sync(false)');
    expect(source.match(/scheduleCanaryFlagSync\(\{/g)).toHaveLength(2);
    expect(source.match(/scheduleXdOrgBetaDefault\(\{/g)).toHaveLength(2);
    expect(source.match(/scheduleNonXdOrgBetaDefault\(\{/g)).toHaveLength(1);
    expect(source).toContain("getClientEndpoint('oauthBrokerApiBaseUrl')");
    expect(source).toContain("apiFetch('/api/user/feature-flags'");

    const syncStart = source.indexOf('function scheduleCanaryFlagSync(');
    const syncEnd = source.indexOf(
      '\n}\n\n/**\n * 登录态落地后为 xd 组织补一次设备级 beta 默认值',
      syncStart,
    );
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    expect(syncBody).toContain("if (outcome.kind === 'synced')");
    expect(syncBody).toContain('notifyRenderer();');

    const betaStart = source.indexOf('function scheduleXdOrgBetaDefault(');
    const betaEnd = source.indexOf('function scheduleNonXdOrgBetaDefault(', betaStart);
    expect(betaEnd).toBeGreaterThan(betaStart);
    const betaBody = source.slice(betaStart, betaEnd);
    expect(betaBody).toContain('if (isPassiveSharedUserDataInstance()) return;');
    expect(betaBody).toContain('decodeAccessTokenOrgSlug(accessToken)');
    expect(betaBody).not.toContain('shouldAttemptOrgBetaDefault');
    const nonXdStart = source.indexOf('function scheduleNonXdOrgBetaDefault(');
    const nonXdEnd = source.indexOf('\n}\n\n/**\n * 冷启动流程的进程内去重', nonXdStart);
    const nonXdBody = source.slice(nonXdStart, nonXdEnd);
    expect(nonXdBody).toContain('shouldAttemptOrgBetaDefault');
    expect(betaBody).toContain('enableUncustomizedBetaChannel');
    expect(betaBody).toContain('authStateEpoch === input.expectedAuthEpoch');
    expect(source).not.toContain('relaunchForChannelChange');

    const clearIntegrationsStart = source.indexOf('async function clearPerAccountIntegrations(');
    const clearIntegrationsEnd = source.indexOf('\n}', clearIntegrationsStart);
    expect(source.slice(clearIntegrationsStart, clearIntegrationsEnd)).not.toContain(
      'canaryFlagStore.clear()',
    );
  });
});
