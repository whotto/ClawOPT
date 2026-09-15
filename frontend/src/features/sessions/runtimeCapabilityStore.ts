// 外部运行时的能力（`GET /api/runtime/member-runtimes`，登录即可）：聊天页按能力显示「分叉」「/compact」这类入口，
// 不按运行时名字写 if。整页读一次，失败按「都不支持」处理。
import { create } from 'zustand';
import { listMemberRuntimes } from '../../api/runtime';

export type RuntimeCapabilitySummary = { id: string; nativeFork: boolean; nativeCompact: boolean; approvals: boolean; available: boolean };

type State = {
  loaded: boolean;
  runtimes: Record<string, RuntimeCapabilitySummary>;
  ensureLoaded: () => void;
};

let inflight: Promise<void> | null = null;

export const useRuntimeCapabilityStore = create<State>((set, get) => ({
  loaded: false,
  runtimes: {},
  ensureLoaded: () => {
    if (get().loaded || inflight) return;
    inflight = (async () => {
      try {
        const response = await listMemberRuntimes();
        const payload = response.ok ? await response.json() : null;
        const runtimes: Record<string, RuntimeCapabilitySummary> = {};
        for (const entry of Array.isArray(payload?.runtimes) ? payload.runtimes : []) {
          if (typeof entry?.id !== 'string') continue;
          runtimes[entry.id] = {
            id: entry.id,
            nativeFork: entry.nativeFork === true,
            nativeCompact: entry.nativeCompact === true,
            approvals: entry.approvals === true,
            available: entry.available === true,
          };
        }
        set({ loaded: true, runtimes });
      } catch {
        set({ loaded: true, runtimes: {} });
      } finally {
        inflight = null;
      }
    })();
  },
}));
