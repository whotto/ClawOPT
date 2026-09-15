import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changePassword, login } from '../api/auth';

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

const AUTH_INVALID_PASSWORD_ERROR_CODE = 'auth.invalidPassword';

interface LoginErrorResponse {
  errorCode?: string;
  errorParams?: Record<string, string | number | boolean | null> | null;
  errorDetail?: string | null;
  message?: string;
  error?: string;
}

function resolveLoginErrorMessage(data: LoginErrorResponse, t: (key: string, options?: any) => string): string {
  const detail = typeof data.errorDetail === 'string' && data.errorDetail.trim() ? data.errorDetail.trim() : '';

  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      return detail ? `${translated}: ${detail}` : translated;
    }
  }

  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }

  if (typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  if (detail) {
    return detail;
  }

  return t(AUTH_INVALID_PASSWORD_ERROR_CODE);
}

const inputClass = 'block w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all text-sm';

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  /** 迁移出来的默认口令账号：登录成功后必须先改口令，其余接口在改之前一律 403。 */
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await login(password, username.trim() || undefined);
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        // 令牌由后端以 httpOnly cookie 下发，前端不持有、也读不到。
        if (data.user?.mustChangePassword) setMustChange(true);
        else onLoginSuccess();
      } else {
        setError(resolveLoginErrorMessage(data, t));
      }
    } catch {
      setError(t('auth.connectionFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setIsLoading(true);
    try {
      const res = await changePassword(password, newPassword);
      const data = await res.json().catch(() => ({}));
      if (data.success) onLoginSuccess();
      else setError(resolveLoginErrorMessage(data, t));
    } catch {
      setError(t('auth.connectionFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm mx-4">
        <div className="mb-8 flex justify-center">
          <div>
            <div className="text-3xl font-black text-gray-900 tracking-tighter leading-tight mb-1 text-center">ClawOPT</div>
            <div className="text-[0.9rem] font-medium text-gray-400 leading-tight text-center">Powered by OpenClaw</div>
          </div>
        </div>

        {mustChange ? (
          <form onSubmit={handleChangePassword} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <div>
              <div className="text-base font-semibold text-gray-900">{t('auth.mustChangeTitle')}</div>
              <p className="text-sm text-gray-500 mt-1">{t('auth.mustChangeHint')}</p>
            </div>
            <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); }} placeholder={t('auth.newPasswordPlaceholder')} autoFocus className={inputClass} />
            <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }} placeholder={t('auth.confirmPasswordPlaceholder')} className={inputClass} />
            {error && <div className="text-sm text-red-500 font-medium bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
            <button type="submit" disabled={isLoading || newPassword.length < 8} className="w-full py-3 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              {isLoading ? t('auth.submitting') : t('auth.changePasswordSubmit')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('auth.usernameLabel')}</label>
              <input type="text" autoComplete="username" value={username} onChange={(e) => { setUsername(e.target.value); setError(''); }} placeholder={t('auth.usernamePlaceholder')} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('auth.passwordLabel')}</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                placeholder={t('auth.passwordPlaceholder')}
                autoFocus
                className={inputClass}
              />
            </div>

            {error && (
              <div className="text-sm text-red-500 font-medium bg-red-50 px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !password}
              className="w-full py-3 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? t('auth.submitting') : t('auth.loginSubmit')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
