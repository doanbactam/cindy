// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  current: {
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
    isInitializing: false,
    dataOwnerId: 'user-1' as string | null,
    canEnterApp: true,
    retryInitialize: vi.fn(async () => undefined),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

import { ProtectedRoute } from '../ProtectedRoute';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<div data-testid="app-shell" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  afterEach(() => {
    cleanup();
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
      retryInitialize: vi.fn(async () => undefined),
    };
  });

  it('keeps the shell mounted while same-owner refresh still allows entry', () => {
    authState.current = { ...authState.current, mode: 'cloud', dataOwnerId: 'user-1' };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  // Regression: with sign-in removed, a failed startup used to leave a blank
  // window because there was no login page left to fall back to.
  it('offers a startup retry when the account-free session could not be opened', async () => {
    const retryInitialize = vi.fn(async () => undefined);
    authState.current = {
      mode: 'signed-out',
      isInitializing: false,
      dataOwnerId: null,
      canEnterApp: false,
      retryInitialize,
    };
    renderAt('/');
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.getByText('startupRecovery.title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'startupRecovery.retry' }));
    await waitFor(() => expect(retryInitialize).toHaveBeenCalledOnce());
  });

  it('lets local mode enter the app without a Cindy account', () => {
    authState.current = { ...authState.current, mode: 'local', dataOwnerId: 'local-v1' };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});
