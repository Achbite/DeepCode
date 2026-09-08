import { useEffect } from 'react';

export function useProjectionPolling(
  sessionId: string | null,
  projectionPollingActive: boolean,
  refresh: () => Promise<void>,
) {
  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled || timeout !== null) return;
      const delay = document.visibilityState === 'hidden'
        ? 10_000
        : projectionPollingActive
          ? 750
          : 4_000;
      timeout = window.setTimeout(() => {
        timeout = null;
        void refresh().finally(schedule);
      }, delay);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      void refresh().finally(schedule);
    };

    schedule();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [projectionPollingActive, refresh, sessionId]);
}

export function useProfilesUpdated(refreshProfiles: () => Promise<void>) {
  useEffect(() => {
    const handleProfilesUpdated = () => {
      void refreshProfiles();
    };
    window.addEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
  }, [refreshProfiles]);
}
