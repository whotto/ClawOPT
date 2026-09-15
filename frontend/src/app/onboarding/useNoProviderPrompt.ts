import { useEffect, useState } from 'react';
import { listMemberRuntimes } from '../../api/runtime';
import { useAccess } from '../access';
import { type NoProviderPrompt, resolveNoProviderPrompt } from './onboardingState';

/**
 * 「还没有可用的模型服务商」提示的数据：模型列表来自壳层（`useModels` 已在轮询），
 * 本机可用的外部运行时在挂载时读一次（`GET /api/runtime/member-runtimes`，登录即可）；
 * 模型列表从空变非空（刚配完服务商）时横幅随壳层轮询自动消失。只读不写。
 */
export function useNoProviderPrompt(input: { modelsLoaded: boolean; modelCount: number; modelsConfigReadFailed: boolean }): NoProviderPrompt {
  const access = useAccess();
  const [runtimes, setRuntimes] = useState<{ loaded: boolean; available: number | null }>({ loaded: false, available: null });

  useEffect(() => {
    let cancelled = false;
    listMemberRuntimes()
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        const list = Array.isArray(body?.runtimes) ? body.runtimes as Array<{ available?: unknown }> : null;
        setRuntimes({ loaded: true, available: list ? list.filter((runtime) => runtime.available === true).length : null });
      })
      .catch(() => {
        if (!cancelled) setRuntimes({ loaded: true, available: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return resolveNoProviderPrompt({
    modelsLoaded: input.modelsLoaded,
    modelCount: input.modelCount,
    modelsConfigReadFailed: input.modelsConfigReadFailed,
    runtimesLoaded: runtimes.loaded,
    availableRuntimeCount: runtimes.available,
    capabilitiesLoaded: access.capabilities !== null,
    canManageModels: access.can('settings.models'),
  });
}
