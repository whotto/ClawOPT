import { describe, expect, it } from 'vitest';
import { createPreviewRequestGuard } from './previewRequestGuard';

describe('createPreviewRequestGuard', () => {
  it('a newer request invalidates and aborts the older one', () => {
    const guard = createPreviewRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first.isCurrent()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
  });

  it('a slow earlier result cannot overwrite the newer one', async () => {
    const guard = createPreviewRequestGuard();
    let shown = '';
    const load = async (name: string, delay: number) => {
      const request = guard.begin();
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (request.isCurrent()) shown = name;
    };
    await Promise.all([load('old.xlsx', 30), load('new.csv', 5)]);
    expect(shown).toBe('new.csv');
  });

  it('cancel (preview closed) invalidates the in-flight request', () => {
    const guard = createPreviewRequestGuard();
    const request = guard.begin();
    guard.cancel();
    expect(request.isCurrent()).toBe(false);
    expect(request.signal.aborted).toBe(true);
  });
});
