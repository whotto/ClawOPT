import { useState, useEffect } from 'react';

type Lang = 'zh-CN' | 'en';

interface Config {
  gatewayUrl: string;
  token?: string;
  password?: string;
  defaultAgent?: string;
  language?: Lang;
}

const textMap = {
  'zh-CN': {
    title: '设置',
    gateway: '网关地址',
    token: 'Token（可选）',
    password: '密码（可选）',
    agent: '默认 Agent',
    test: '测试连接',
    save: '保存设置',
    ok: '连接成功',
    fail: '连接失败',
  },
  en: {
    title: 'Settings',
    gateway: 'Gateway URL',
    token: 'Token (optional)',
    password: 'Password (optional)',
    agent: 'Default Agent',
    test: 'Test Connection',
    save: 'Save Settings',
    ok: 'Connection successful',
    fail: 'Connection failed',
  },
};

export default function ConfigPage({ lang = 'zh-CN' }: { lang?: Lang }) {
  const t = textMap[lang];
  const API_BASE = `${window.location.protocol}//${window.location.hostname}:3100`;
  const [config, setConfig] = useState<Config>({
    gatewayUrl: 'ws://localhost:18789',
    defaultAgent: 'main',
    language: 'zh-CN',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then(r => r.json())
      .then(data => setConfig(prev => ({ ...prev, ...data })))
      .catch(console.error);
  }, []);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      alert(res.ok ? 'Saved' : 'Save failed');
    } catch {
      alert('Save error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTest = async () => {
    setIsLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      setTestResult(await res.json());
    } catch {
      setTestResult({ success: false, message: 'Test failed' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">{t.title}</h1>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t.gateway}</label>
          <input
            type="text"
            value={config.gatewayUrl}
            onChange={(e) => setConfig({ ...config, gatewayUrl: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="ws://localhost:18789"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t.token}</label>
          <input
            type="text"
            value={config.token || ''}
            onChange={(e) => setConfig({ ...config, token: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t.password}</label>
          <input
            type="password"
            value={config.password || ''}
            onChange={(e) => setConfig({ ...config, password: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t.agent}</label>
          <input
            type="text"
            value={config.defaultAgent || 'main'}
            onChange={(e) => setConfig({ ...config, defaultAgent: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        {testResult && (
          <div className={`p-4 rounded-lg ${testResult.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            <p className="font-medium">{testResult.success ? `✓ ${t.ok}` : `✗ ${t.fail}`}</p>
            {testResult.message && <p className="text-sm mt-1">{testResult.message}</p>}
          </div>
        )}

        <div className="flex gap-3 pt-4">
          <button onClick={handleTest} disabled={isLoading} className="px-4 py-2 border border-gray-300 rounded-lg">
            {t.test}
          </button>
          <button onClick={handleSave} disabled={isLoading} className="px-4 py-2 bg-blue-600 text-white rounded-lg">
            {t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
