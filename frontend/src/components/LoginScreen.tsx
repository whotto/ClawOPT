import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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

export default function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        if (data.token) {
          localStorage.setItem('clawopt_auth_token', data.token);
        }
        onLoginSuccess();
      } else {
        setError(resolveLoginErrorMessage(data, t));
      }
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

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">请输入登录密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(e); }}
              placeholder="输入密码..."
              autoFocus
              className="block w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all text-sm"
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
            {isLoading ? '验证中...' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
}
