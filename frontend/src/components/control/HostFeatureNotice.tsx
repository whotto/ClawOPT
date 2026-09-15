// 重型功能被主机能力闸门挡下时的统一提示：「本机不可用：原因 + 怎么开」（吸收方案 §3.5）。
// 后端给 `host.<code>` 形状的 reasonCode；这里换成 hostFeature.reason.<code> / hostFeature.howTo.<code>，没有对应文案时只显示原始码。
import { RefreshCw, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ControlUi';

export function hostFeatureCode(reasonCode: string | null | undefined): string | null {
  if (!reasonCode) return null;
  return reasonCode.startsWith('host.') ? reasonCode.slice('host.'.length) : reasonCode;
}

export function HostFeatureNotice({ reasonCode, detail, onRefresh, refreshing }: {
  reasonCode: string | null | undefined;
  /** 诊断细节（已脱敏），单独一行等宽显示。 */
  detail?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const code = hostFeatureCode(reasonCode);
  const reasonKey = `hostFeature.reason.${code}`;
  const howToKey = `hostFeature.howTo.${code}`;
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900" data-testid="host-feature-notice">
      <div className="flex items-start gap-3">
        <ServerOff className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="font-semibold">{t('hostFeature.unavailableTitle')}</div>
          <div>
            <div className="text-xs font-medium text-amber-700">{t('hostFeature.reasonLabel')}</div>
            <div>{code && i18n.exists(reasonKey) ? t(reasonKey) : (reasonCode ?? '')}</div>
          </div>
          {code && i18n.exists(howToKey) && (
            <div>
              <div className="text-xs font-medium text-amber-700">{t('hostFeature.howToLabel')}</div>
              <div className="break-words">{t(howToKey)}</div>
            </div>
          )}
          {detail && <div className="rounded-xl border border-amber-100 bg-white/70 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">{detail}</div>}
        </div>
        {onRefresh && (
          <Button size="sm" onClick={onRefresh} busy={refreshing}>
            <RefreshCw className="w-3.5 h-3.5" />
            {t('hostFeature.refresh')}
          </Button>
        )}
      </div>
    </div>
  );
}
