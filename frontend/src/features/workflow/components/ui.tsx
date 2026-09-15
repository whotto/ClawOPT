// 自动化页面共用的小部件。视觉沿用设置页：圆角 xl/2xl、浅灰边框、无阴影、琥珀色选中态。
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** 不带宽度的输入框外观；行内控件用它自己配宽度（和 `w-full` 叠在一起时谁赢取决于生成顺序，不可靠）。 */
export const fieldClass = 'px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm';
export const inputClass = `block w-full ${fieldClass}`;
export const selectClass = inputClass;
export const primaryButton = 'shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
export const secondaryButton = 'shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
export const dangerButton = 'shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-xl border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
export const iconButton = 'p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-40';

export function Modal({ title, onClose, children, footer, width = 'max-w-2xl' }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={`bg-white sm:rounded-2xl rounded-t-2xl border border-gray-200 w-full ${width} max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100vh-2rem)] flex flex-col relative z-10`}>
        <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-center gap-3">
          <h3 className="text-base font-bold text-gray-900 min-w-0 truncate">{title}</h3>
          <button onClick={onClose} className={iconButton} title={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4 flex-1">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gray-100 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, required }: { label: ReactNode; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-900 mb-1.5">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

export function ErrorBanner({ message, detail, onDismiss }: { message: string; detail?: string | null; onDismiss?: () => void }) {
  return (
    <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
      <X className="w-4 h-4 shrink-0 mt-0.5 cursor-pointer" onClick={onDismiss} />
      <div className="min-w-0">
        <div>{message}</div>
        {detail && <div className="mt-1 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">{detail}</div>}
      </div>
    </div>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return <div className="p-3 bg-amber-50 text-gray-700 text-sm rounded-xl border border-orange-200">{children}</div>;
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-green-50 text-green-700 border-green-200',
  completed_with_failures: 'bg-amber-50 text-amber-700 border-orange-200',
  running: 'bg-blue-50 text-blue-700 border-blue-200',
  queued: 'bg-gray-50 text-gray-600 border-gray-200',
  pending_approval: 'bg-amber-50 text-amber-700 border-orange-300',
  failed: 'bg-red-50 text-red-600 border-red-200',
  approval_rejected: 'bg-red-50 text-red-600 border-red-200',
  canceled: 'bg-gray-100 text-gray-500 border-gray-200',
  skipped: 'bg-gray-50 text-gray-400 border-gray-200',
  idle: 'bg-white text-gray-400 border-gray-200',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-lg border whitespace-nowrap ${STATUS_STYLE[status] ?? STATUS_STYLE.idle}`}>
      {label ?? t(`automation.status.${status}`)}
    </span>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-sm text-gray-700 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full border transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-gray-100 border-gray-300'}`}
      >
        <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white border border-gray-200 transition-all ${checked ? 'left-4' : 'left-0.5'}`} />
      </button>
      <span>{label}</span>
    </label>
  );
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 浏览器里生成文件并触发下载（不经服务器落盘）。 */
export function downloadText(fileName: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
