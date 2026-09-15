// 全局故障转移的自动保存：只由「用户改了」触发，「从服务端读到了」永远不写。
//
// 之前的实现是 useEffect 盯着 [mode, fallbacks] 变化就保存，靠一个 setTimeout(0) 解锁的「抑制标记」
// 把加载那一次挡掉。可 useEffect 在提交之后的另一个任务里才跑，解锁定时器经常抢在它前面——
// 于是每次进设置页（任何页签、任何角色）加载完都会把刚读到的值原样 PUT 回去：
// admin 多一次无意义的写 openclaw.json，member 直接吃 403。靠时序挡副作用挡不住，改成按意图触发。
import type { ModelFallbackMode } from '../../../components/ModelFallbackEditor';

export type FallbackDraft = { mode: ModelFallbackMode; fallbacks: string[] };

type Timers = {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

export const FALLBACK_AUTOSAVE_DELAY_MS = 180;

/** 「自定义但一个都没选」是编辑中的过渡态，不保存。 */
export function isSavableFallbackDraft(draft: FallbackDraft): boolean {
  return !(draft.mode === 'custom' && draft.fallbacks.length === 0);
}

/** 模型勾选变化后的草稿：清空即关闭，有选中即自定义。 */
export function draftForSelection(fallbacks: string[]): FallbackDraft {
  return { mode: fallbacks.length === 0 ? 'disabled' : 'custom', fallbacks };
}

/** 写入请求体：关闭时一律写空列表。 */
export function fallbackSaveBody(draft: FallbackDraft): { fallbacks: string[] } {
  return { fallbacks: draft.mode === 'disabled' ? [] : draft.fallbacks };
}

export function createFallbackAutosave(options: {
  save: (draft: FallbackDraft) => void;
  delayMs?: number;
  timers?: Timers;
}) {
  const timers: Timers = options.timers ?? { set: (callback, delayMs) => window.setTimeout(callback, delayMs), clear: (handle) => window.clearTimeout(handle as number) };
  const delayMs = options.delayMs ?? FALLBACK_AUTOSAVE_DELAY_MS;
  let pending: unknown = null;

  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };

  return {
    /** 从服务端读到（首次加载、删模型后重拉、保存成功的回包）：只取消还没发出的保存，绝不写。 */
    loaded(): void {
      cancel();
    },
    /** 用户改了：去抖后保存这份草稿（不读闭包里的旧状态）。 */
    edited(draft: FallbackDraft): void {
      cancel();
      if (!isSavableFallbackDraft(draft)) return;
      pending = timers.set(() => {
        pending = null;
        options.save(draft);
      }, delayMs);
    },
    dispose: cancel,
  };
}

export type FallbackAutosave = ReturnType<typeof createFallbackAutosave>;
