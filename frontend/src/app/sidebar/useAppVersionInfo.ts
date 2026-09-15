import { useEffect, useState } from 'react';
import { getVersion } from '../../api/update';
import type { AppVersionInfo } from './sidebarTypes';

export function useAppVersionInfo() {
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.version === 'string') {
          setAppVersionInfo({
            version: data.version,
            openclawVersion: typeof data?.openclawVersion === 'string' ? data.openclawVersion : null,
          });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return appVersionInfo;
}
