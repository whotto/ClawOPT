// 运行时管理页用的小部件。样式沿用设置页：白底、浅灰边框、圆角 xl/2xl、蓝色主按钮、无阴影。
import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ErrorDisplay } from './runtimeLogic';

export const inputClass = 'block w-full px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed';
export const editorClass = 'block w-full min-h-[16rem] px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-[13px] font-mono leading-relaxed resize-y';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 border border-blue-600',
  secondary: 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
  ghost: 'bg-transparent text-gray-600 border border-transparent hover:bg-gray-100',
};

export function Button({ variant = 'secondary', onClick, disabled, busy, children, title, size = 'md' }: {
  variant?: ButtonVariant; onClick?: () => void; disabled?: boolean; busy?: boolean; children: ReactNode; title?: string; size?: 'sm' | 'md';
}) {
  const sizeClass = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm';
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`${sizeClass} rounded-xl font-medium transition-all inline-flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_CLASS[variant]}`}
    >
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
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

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-gray-200 ${className}`}>{children}</div>;
}

export function ErrorBanner({ error, onClose, action }: { error: ErrorDisplay | null; onClose?: () => void; action?: ReactNode }) {
  if (!error?.message) return null;
  return (
    <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="break-words">{error.message}</div>
        {error.detail && (
          <div className="mt-2 rounded-lg border border-red-100 bg-white/70 px-2 py-1.5 text-xs text-red-500 whitespace-pre-wrap break-all font-mono max-h-40 overflow-auto">{error.detail}</div>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="text-red-400 hover:text-red-600" aria-label="close">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className={`inline-flex items-center gap-2 text-xs text-gray-600 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <span className="relative inline-flex items-center">
        <input type="checkbox" className="sr-only peer" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span className="w-9 h-5 bg-gray-200 rounded-full peer-checked:bg-blue-500 transition-colors" />
        <span className="absolute left-0.5 top-0.5 w-4 h-4 bg-white border border-gray-200 rounded-full transition-transform peer-checked:translate-x-4" />
      </span>
      {label}
    </label>
  );
}

export async function readJson<T = any>(response: Response): Promise<T> {
  return response.json().catch(() => ({} as T));
}
