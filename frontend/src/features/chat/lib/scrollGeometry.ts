// 滚动区几何：贴底判定、导航点采样与当前点定位。
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, NAV_DOTS_MAX_VISIBLE } from './constants';
import type { NavDot } from './types';

export function isContainerNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

export function sampleNavDots(dots: NavDot[], maxVisible = NAV_DOTS_MAX_VISIBLE): NavDot[] {
  if (dots.length <= maxVisible) return dots;
  if (maxVisible <= 1) return dots.length > 0 ? [dots[0]] : [];

  const sampled: NavDot[] = [];
  const seen = new Set<number>();
  const lastIndex = dots.length - 1;
  const step = lastIndex / (maxVisible - 1);

  for (let i = 0; i < maxVisible; i += 1) {
    const index = i === maxVisible - 1 ? lastIndex : Math.round(i * step);
    if (seen.has(index)) continue;
    seen.add(index);
    sampled.push(dots[index]);
  }

  return sampled;
}

export function resolveClosestNavDotId(dots: NavDot[], container: HTMLElement): string | null {
  if (dots.length === 0) return null;

  const scrollTop = container.scrollTop;
  let closest: string | null = null;
  let closestDist = Infinity;

  dots.forEach(dot => {
    const dist = Math.abs(dot.offsetTop - scrollTop - container.clientHeight / 3);
    if (dist < closestDist) {
      closestDist = dist;
      closest = dot.id;
    }
  });

  return closest;
}
