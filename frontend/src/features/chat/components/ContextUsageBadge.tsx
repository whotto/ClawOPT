// 输入框下方的上下文占用徽标：「已用 / 窗口 · 剩余」+ 进度条（60% 提醒、80% 危险），接近上限时提示 /compact。
// 数据来自运行时报的用量（ClawOPT 不拥有模型上下文，只显示运行时说的）。一轮结束、会话切换、实时通道报用量时重拉。
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getChatContextUsage } from '../../../api/chat';
import { formatTokenCount, normalizeContextUsage, usageTone, type ContextUsageView } from '../run/contextUsage';

export function ContextUsageBadge({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<ContextUsageView | null>(null);
  const seqRef = useRef(0);

  useEffect(() => { setUsage(null); }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const seq = ++seqRef.current;
    const controller = new AbortController();
    getChatContextUsage(sessionId, controller.signal)
      .then((response) => response.json())
      .then((payload) => { if (seq === seqRef.current) setUsage(normalizeContextUsage(payload)); })
      .catch(() => {});
    return () => controller.abort();
  }, [sessionId, refreshKey]);

  if (!usage || usage.usedTokens === null) return null;
  const tone = usageTone(usage.percent);
  const bar = tone === 'danger' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-blue-500';
  const text = tone === 'danger' ? 'text-red-600' : tone === 'warn' ? 'text-amber-700' : 'text-gray-500';
  const remaining = usage.contextWindow !== null ? Math.max(0, usage.contextWindow - usage.usedTokens) : null;
  return (
    <div
      className={`flex items-center gap-2 text-[11px] ${text}`}
      title={tone === 'normal' ? t('contextUsage.hint') : t('contextUsage.compactHint')}
      data-testid="context-usage-badge"
    >
      {usage.contextWindow !== null && (
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
          <span className={`block h-full ${bar}`} style={{ width: `${Math.min(100, usage.percent ?? 0)}%` }} />
        </span>
      )}
      <span>
        {usage.contextWindow !== null
          ? t('contextUsage.usedOfWindow', { used: formatTokenCount(usage.usedTokens), window: formatTokenCount(usage.contextWindow), remaining: formatTokenCount(remaining ?? 0) })
          : t('contextUsage.usedOnly', { used: formatTokenCount(usage.usedTokens) })}
        {usage.approximate ? ` ${t('contextUsage.approximate')}` : ''}
      </span>
      {tone === 'danger' && <span className="rounded border border-red-200 bg-red-50 px-1">{t('contextUsage.suggestCompact')}</span>}
    </div>
  );
}
