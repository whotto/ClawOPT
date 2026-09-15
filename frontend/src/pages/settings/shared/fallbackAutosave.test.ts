/// <reference types="vite/client" />
// 设置页加载时不许写：此前每次进设置页都会把刚读到的全局故障转移原样 PUT 回去（member 直接 403）。
import { describe, expect, it } from 'vitest';
import modelSettingsSource from '../hooks/useModelSettings.ts?raw';
import { createFallbackAutosave, draftForSelection, fallbackSaveBody, type FallbackDraft } from './fallbackAutosave';

function fakeTimers() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    timers: {
      set: (callback: () => void) => { const id = next++; queue.set(id, callback); return id; },
      clear: (handle: unknown) => { queue.delete(handle as number); },
    },
    flush: () => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach((callback) => callback()); },
    pending: () => queue.size,
  };
}

describe('全局故障转移自动保存', () => {
  it('从服务端读到值：不写（加载、重拉都一样）', () => {
    const clock = fakeTimers();
    const saved: FallbackDraft[] = [];
    const autosave = createFallbackAutosave({ save: (draft) => saved.push(draft), timers: clock.timers });
    autosave.loaded();
    autosave.loaded();
    clock.flush();
    expect(saved).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('用户改了：去抖后只保存最后一份草稿', () => {
    const clock = fakeTimers();
    const saved: FallbackDraft[] = [];
    const autosave = createFallbackAutosave({ save: (draft) => saved.push(draft), timers: clock.timers });
    autosave.edited(draftForSelection(['a']));
    autosave.edited(draftForSelection(['a', 'b']));
    clock.flush();
    expect(saved).toEqual([{ mode: 'custom', fallbacks: ['a', 'b'] }]);
  });

  it('改到一半（自定义但没选）不保存；改完之后又读到服务端的值：取消还没发出的保存', () => {
    const clock = fakeTimers();
    const saved: FallbackDraft[] = [];
    const autosave = createFallbackAutosave({ save: (draft) => saved.push(draft), timers: clock.timers });
    autosave.edited({ mode: 'custom', fallbacks: [] });
    expect(clock.pending()).toBe(0);
    autosave.edited(draftForSelection(['a']));
    autosave.loaded();
    clock.flush();
    expect(saved).toEqual([]);
  });

  it('请求体：关闭时写空列表', () => {
    expect(fallbackSaveBody({ mode: 'disabled', fallbacks: ['a'] })).toEqual({ fallbacks: [] });
    expect(fallbackSaveBody({ mode: 'custom', fallbacks: ['a'] })).toEqual({ fallbacks: ['a'] });
    expect(draftForSelection([])).toEqual({ mode: 'disabled', fallbacks: [] });
  });

  it('接线：设置页的状态 hook 不再按状态变化自动保存，读到的值走 loaded()，界面拿不到原始 setter', () => {
    const source = modelSettingsSource;
    // 盯着 [globalFallbackMode, globalFallbacks] 的 effect 就是那次「加载即写」的来源。
    expect(source).not.toMatch(/useEffect\([\s\S]{0,600}?\[\s*globalFallbackMode\s*,\s*globalFallbacks\s*\]/);
    expect(source).not.toMatch(/suppressGlobalFallbackAutosave/);
    const fetchBody = source.slice(source.indexOf('const fetchGlobalFallbacks'), source.indexOf('const fetchEndpoints'));
    expect(fetchBody).toContain('globalFallbackAutosave.loaded()');
    expect(fetchBody).not.toMatch(/edited\(|saveModelFallbacks/);
    const returned = source.slice(source.lastIndexOf('return {'));
    expect(returned).not.toMatch(/\bsetGlobalFallbacks\b|\bsetGlobalFallbackMode\b/);
  });
});
