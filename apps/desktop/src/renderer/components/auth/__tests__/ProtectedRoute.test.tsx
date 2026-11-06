// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  current: {
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
    isInitializing: false,
    dataOwnerId: 'user-1' as string | null,
    canEnterApp: true,
  },
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
    };
  });

  it('keeps the shell mounted while same-owner refresh still allows entry', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });

  it('renders nothing while the local session is still being committed', () => {
    authState.current = {
      mode: 'local',
      isInitializing: false,
      dataOwnerId: 'local-v1',
      canEnterApp: false,
    };
    const { container } = renderAt('/');
    expect(container.innerHTML).toBe('');
  });

  it('lets local mode enter the app without a Cindy account', () => {
    authState.current = {
      mode: 'local',
      isInitializing: false,
      dataOwnerId: 'local-v1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});
