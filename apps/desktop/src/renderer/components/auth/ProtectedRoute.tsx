import { Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function ProtectedRoute() {
  const { canEnterApp, isInitializing, dataOwnerId } = useAuth();

  if (isInitializing) return null;
  // Sign-in is removed, so canEnterApp is only false while the local session
  // is being committed. Render nothing until it settles.
  if (!canEnterApp) return null;

  // Owner changes must remount the protected tree so transient New Maker
  // drafts and other route-local state cannot leak across data namespaces.
  return <Outlet key={dataOwnerId ?? 'signed-out'} />;
}
