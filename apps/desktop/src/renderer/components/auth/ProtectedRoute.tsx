import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/contexts/AuthContext';

export function ProtectedRoute() {
  const { canEnterApp, isInitializing, dataOwnerId } = useAuth();

  if (isInitializing) return null;
  // Sign-in is removed, so there is no other page to fall back to. When the
  // account-free session could not be opened, offer a retry instead of a blank
  // window.
  if (!canEnterApp) return <StartupRecoveryScreen />;

  // Owner changes must remount the protected tree so transient New Maker
  // drafts and other route-local state cannot leak across data namespaces.
  return <Outlet key={dataOwnerId ?? 'signed-out'} />;
}

/** Same unescapable full-surface pattern as LocalDbFatalScreen. */
function StartupRecoveryScreen() {
  const { t } = useTranslation();
  const { retryInitialize } = useAuth();
  const [retrying, setRetrying] = useState(false);

  return (
    <div
      className="fixed inset-0 z-[9999]"
      style={{ background: 'var(--surface)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title={t('startupRecovery.title')}
        description={t('startupRecovery.description')}
        showCancel={false}
        autoFocusConfirm
        loading={retrying}
        confirmText={t('startupRecovery.retry')}
        onConfirm={() => {
          if (retrying) return;
          setRetrying(true);
          void retryInitialize().finally(() => setRetrying(false));
        }}
      />
    </div>
  );
}
