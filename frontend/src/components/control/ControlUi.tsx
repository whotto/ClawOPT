// 控制面页面共用的小部件。样式与设置页一致：白底、浅灰边框、圆角 xl/2xl、蓝色主按钮、无阴影。
import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const inputClass = 'block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed';
export const textareaClass = `${inputClass} font-mono leading-relaxed`;
export const labelClass = 'block text-sm font-medium text-gray-900 mb-1.5';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 border border-blue-600',
  secondary: 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
  ghost: 'bg-transparent text-gray-600 border border-transparent hover:bg-gray-100',
};

export function Button({
  variant = 'secondary',
  onClick,
  disabled,
  busy,
  children,
  type = 'button',
  title,
  size = 'md',
}: {
  variant?: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
  type?: 'button' | 'submit';
  title?: string;
  size?: 'sm' | 'md';
}) {
  const sizeClass = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm';
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`${sizeClass} rounded-xl font-medium transition-all inline-flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_CLASS[variant]}`}
    >
      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

export function PageIntro({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{title}</h3>
        {description && <p className="text-sm text-gray-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-gray-200 ${className}`}>{children}</div>;
}

type BadgeTone = 'gray' | 'green' | 'amber' | 'red' | 'blue';
const BADGE_CLASS: Record<BadgeTone, string> = {
  gray: 'bg-gray-100 text-gray-600 border-gray-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-600 border-red-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
};

export function Badge({ tone = 'gray', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap ${BADGE_CLASS[tone]}`}>{children}</span>;
}

export type ErrorDisplay = { message: string; detail: string };

export function ErrorBanner({ error, onClose }: { error: ErrorDisplay | null; onClose?: () => void }) {
  if (!error?.message) return null;
  return (
    <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
      <X className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div>{error.message}</div>
        {error.detail && (
          <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">{error.detail}</div>
        )}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="text-red-400 hover:text-red-600">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'blue' | 'green' }) {
  const toneClass = tone === 'blue' ? 'bg-blue-50 text-blue-700 border-blue-100' : tone === 'green' ? 'bg-green-50 text-green-700 border-green-100' : 'bg-amber-50 text-amber-800 border-amber-100';
  return (
    <div className={`p-3 text-sm rounded-xl border flex items-start gap-2 ${toneClass}`}>
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="bg-white rounded-2xl border border-gray-200 px-4 py-12 text-center text-gray-400 text-sm">{children}</div>;
}

export function LoadingRow() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
      <Loader2 className="w-4 h-4 animate-spin" />
      {t('control.common.loading')}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width = 'max-w-2xl' }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`bg-white rounded-2xl border border-gray-200 w-full ${width} max-h-[calc(100vh-2rem)] flex flex-col relative z-10`}>
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center gap-3">
          <h3 className="text-lg font-bold text-gray-900 min-w-0 truncate">{title}</h3>
          <button type="button" onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg" title={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex flex-wrap justify-end gap-2 rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger = true, busy, onConfirm, onCancel }: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width="max-w-md"
      footer={(
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="text-sm text-gray-600 whitespace-pre-wrap break-words">{message}</div>
    </Modal>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export function formatTime(ms: number | null | undefined, language: string): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString(language || undefined);
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatNumber(value: number, language: string): string {
  try {
    return value.toLocaleString(language || undefined);
  } catch {
    return String(value);
  }
}
