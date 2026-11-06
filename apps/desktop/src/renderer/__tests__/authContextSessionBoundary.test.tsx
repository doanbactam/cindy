// @vitest-environment jsdom

import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let authStateListener: ((state: unknown) => void) | undefined;
  let expiredListener: ((payload: { message?: string }) => void) | undefined;
  const service = {
    initialize: vi.fn(),
    consumeAccountDeletionRestoredNotice: vi.fn(async () => true),
    onAuthStateChange: vi.fn((listener: (state: unknown) => void) => {
      authStateListener = listener;
      return () => {
        authStateListener = undefined;
      };
    }),
    dispose: vi.fn(),
  };
  return {
    service,
    reset: vi.fn(),
    cancelRemoteOptimisticSendsForDataOwnerBoundary: vi.fn(),
    reconcileSessionsAfterDataOwnerRollback: vi.fn(async () => undefined),
    getMe: vi.fn(async () => ({ role: 'user' })),
    clearWorkersCache: vi.fn(),
    setModelVisibilityOwner: vi.fn(),
    invalidateProvidersSnapshot: vi.fn(),
    preloadLocalCatalogSnapshot: vi.fn(async () => undefined),
    setMemorySettingsOwner: vi.fn(),
    bootstrapMemorySettingsFromMain: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    emitAuth(state: unknown) {
      authStateListener?.(state);
    },
    registerExpired(listener: (payload: { message?: string }) => void) {
      expiredListener = listener;
      return () => {
        expiredListener = undefined;
      };
    },
    emitExpired() {
      expiredListener?.({ message: 'expired' });
    },
  };
});

vi.mock('@/lib/authService', () => ({
  createAuthService: () => mocks.service,
}));
vi.mock('@/lib/makerChatStore', () => ({
  cancelRemoteOptimisticSendsForDataOwnerBoundary:
    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary,
  reconcileSessionsAfterDataOwnerRollback: mocks.reconcileSessionsAfterDataOwnerRollback,
  setCurrentUserName: vi.fn(),
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { reset: mocks.reset },
}));
vi.mock('@/lib/meService', () => ({ getMe: mocks.getMe }));
vi.mock('@/features/cc-agent/hooks/useWorkers', () => ({
  clearWorkersCache: mocks.clearWorkersCache,
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  setModelVisibilityOwner: mocks.setModelVisibilityOwner,
}));
vi.mock('@/lib/providersSnapshotStore', () => ({
  invalidateProvidersSnapshot: mocks.invalidateProvidersSnapshot,
}));
vi.mock('@/lib/localCatalogSnapshot', () => ({
  preloadLocalCatalogSnapshot: mocks.preloadLocalCatalogSnapshot,
}));
vi.mock('@/lib/memorySettingsStore', () => ({
  setMemorySettingsOwner: mocks.setMemorySettingsOwner,
  bootstrapMemorySettingsFromMain: mocks.bootstrapMemorySettingsFromMain,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
const translate = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
const restoredToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toast: { success: restoredToast },
}));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import {
  __testing as dataOwnerGenerationTesting,
  getDataOwnerGeneration,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

function user(id: string) {
  return {
    id,
    name: id,
    avatar: null,
    email: `${id}@example.com`,
    defaultModel: 'model',
    defaultEffort: 'medium',
    membershipKind: 'personal' as const,
    membershipRole: 'owner' as const,
    orgId: null,
    orgName: null,
    orgSlug: null,
    passportId: `${id}-passport`,
  };
}

function authState(id: string | null, isCanary = false) {
  return {
    user: id ? user(id) : null,
    mode: id ? ('cloud' as const) : ('signed-out' as const),
    dataOwnerId: id,
    ownerGeneration: id ? 1 : 2,
    canEnterApp: id !== null,
    isAuthenticated: id !== null,
    isCanary,
    deviceId: 'device',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  };
}

function localAuthState() {
  return {
    user: null,
    mode: 'local' as const,
    dataOwnerId: 'local-v1',
    ownerGeneration: 3,
    canEnterApp: true,
    isAuthenticated: false,
    isCanary: false,
    deviceId: 'device',
    hasAccountDeletionReceipt: false,
    accountDeletionRestored: false,
  };
}

describe('AuthContext session cache boundaries', () => {
  const wrapper = ({ children }: PropsWithChildren) => <AuthProvider>{children}</AuthProvider>;

  beforeEach(() => {
    mocks.reset.mockClear();
    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary.mockClear();
    mocks.reconcileSessionsAfterDataOwnerRollback.mockClear();
    mocks.getMe.mockClear();
    mocks.clearWorkersCache.mockClear();
    mocks.setModelVisibilityOwner.mockClear();
    mocks.invalidateProvidersSnapshot.mockClear();
    mocks.preloadLocalCatalogSnapshot.mockClear();
    mocks.setMemorySettingsOwner.mockClear();
    mocks.bootstrapMemorySettingsFromMain.mockClear();
    dataOwnerGenerationTesting.reset();
    mocks.service.consumeAccountDeletionRestoredNotice.mockClear();
    restoredToast.mockClear();
    mocks.confirm.mockClear();
    mocks.service.initialize.mockResolvedValue(authState('account-a'));
    (
      window as unknown as { electronAPI: { onAuthSessionExpired: typeof mocks.registerExpired } }
    ).electronAPI = {
      onAuthSessionExpired: mocks.registerExpired,
    };
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mocks.service.dispose.mockClear();
  });

  it('resets sessions when auth state switches accounts or logs out', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith('account-a', 1, 'cloud');

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith('account-b', 1, 'cloud');

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.reset).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(2);

    act(() => mocks.emitAuth(authState(null)));
    expect(mocks.reset).toHaveBeenCalledTimes(3);
    expect(mocks.invalidateProvidersSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.setModelVisibilityOwner).toHaveBeenLastCalledWith(null, 2, 'signed-out');

  });

  it('does not finalize restored turns during the first owner hydration', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBe('account-a'));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenCalledWith({
      finalizeSessions: false,
    });
    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).not.toHaveBeenCalledWith({
      finalizeSessions: true,
    });

    act(() => mocks.emitAuth(authState('account-b')));
    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: true,
    });
  });

  it('preserves the owner when the first snapshot is a boundary-pending projection', async () => {
    setDataOwnerGeneration('account-a', 1);
    mocks.service.initialize.mockResolvedValue({ ...authState(null), ownerGeneration: 1 });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: false,
    });

    act(() => mocks.emitAuth(authState('account-a')));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: false,
    });
    expect(mocks.reconcileSessionsAfterDataOwnerRollback).toHaveBeenCalledOnce();
    expect(view.result.current.dataOwnerId).toBe('account-a');
    expect(mocks.setMemorySettingsOwner).toHaveBeenLastCalledWith('account-a');
    expect(mocks.bootstrapMemorySettingsFromMain).toHaveBeenCalled();
  });

  it('preserves a pending rollback when the first snapshot has no owner stamp', async () => {
    mocks.service.initialize.mockResolvedValue({ ...authState(null), ownerGeneration: 1 });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).not.toHaveBeenCalledWith({
      finalizeSessions: true,
    });
    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary.mockClear();

    act(() => mocks.emitAuth(authState('account-a')));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: false,
    });
    expect(mocks.reconcileSessionsAfterDataOwnerRollback).toHaveBeenCalledOnce();
    expect(view.result.current.dataOwnerId).toBe('account-a');
  });

  it('preserves a generation-zero pending rollback from a startup-local boundary', async () => {
    // A renderer opened while a process that started in local mode is leaving
    // that owner receives the transient signed-out projection at generation 0.
    // The explicit pending marker disambiguates it from a stable signed-out
    // startup snapshot.
    mocks.service.initialize.mockResolvedValue({
      ...authState(null),
      ownerGeneration: 0,
      ownerBoundaryPending: true,
    });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).not.toHaveBeenCalledWith({
      finalizeSessions: true,
    });
    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary.mockClear();

    act(() => mocks.emitAuth({ ...localAuthState(), ownerGeneration: 0 }));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: false,
    });
    expect(mocks.reconcileSessionsAfterDataOwnerRollback).toHaveBeenCalledOnce();
    expect(view.result.current.dataOwnerId).toBe('local-v1');
  });

  it('finalizes a committed owner change after a first pending snapshot', async () => {
    mocks.service.initialize.mockResolvedValue({
      ...authState(null),
      ownerGeneration: 1,
      ownerBoundaryPending: true,
    });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary.mockClear();
    act(() => mocks.emitAuth({ ...authState('account-b'), ownerGeneration: 2 }));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: true,
    });
    expect(view.result.current.dataOwnerId).toBe('account-b');
  });

  it('finalizes a fresh renderer when a pending projection commits to null', async () => {
    mocks.service.initialize.mockResolvedValue({
      ...authState(null),
      ownerGeneration: 1,
      ownerBoundaryPending: true,
    });
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.dataOwnerId).toBeNull());

    mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary.mockClear();
    act(() => mocks.emitAuth({ ...authState(null), ownerGeneration: 2 }));

    expect(mocks.cancelRemoteOptimisticSendsForDataOwnerBoundary).toHaveBeenLastCalledWith({
      finalizeSessions: true,
    });
    expect(mocks.reset).toHaveBeenCalled();
    expect(mocks.clearWorkersCache).toHaveBeenCalled();
    expect(mocks.setMemorySettingsOwner).toHaveBeenLastCalledWith(null);
    expect(mocks.bootstrapMemorySettingsFromMain).toHaveBeenCalled();
    expect(view.result.current.dataOwnerId).toBeNull();
  });

  it('resets sessions when authentication expires', async () => {
    renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(mocks.service.initialize).toHaveBeenCalled());

    mocks.reset.mockClear();
    act(() => mocks.emitExpired());
    await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  });

  it('exposes the pushed owner generation so same-owner repairs are observable (#4469)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    act(() => {
      mocks.emitAuth({ ...authState('a'), ownerGeneration: 1 });
    });
    await waitFor(() => expect(result.current.dataOwnerGeneration).toBe(1));
    mocks.reset.mockClear();

    // Same-owner projection repair: generation advances, owner does not.
    act(() => {
      mocks.emitAuth({ ...authState('a'), ownerGeneration: 2 });
    });
    await waitFor(() => expect(result.current.dataOwnerGeneration).toBe(2));
    expect(result.current.dataOwnerId).toBe('a');
    expect(getDataOwnerGeneration()).toEqual({ dataOwnerId: 'a', generation: 2 });
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('updates Canary state without treating it as an account switch', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));

    mocks.reset.mockClear();
    act(() => mocks.emitAuth(authState('account-a', true)));

    expect(view.result.current.isCanary).toBe(true);
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('consumes the restored account-deletion notice once', async () => {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(view.result.current.user?.id).toBe('account-a'));

    act(() =>
      mocks.emitAuth({
        ...authState('account-a'),
        accountDeletionRestored: true,
      }),
    );

    await waitFor(() => {
      expect(mocks.service.consumeAccountDeletionRestoredNotice).toHaveBeenCalledTimes(1);
    });
    expect(view.result.current.accountDeletionRestored).toBe(false);
  });
});
