import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { getRuntimeConfig } from '../../../api/runtime';
import McpPanel from './McpPanel';
import NativeFileEditor from './NativeFileEditor';
import { resolveApiErrorMessage, type ErrorDisplay, readJson } from './runtimeLogic';
import { Badge, Button, Card, ErrorBanner } from '../../../components/control/ControlUi';

type ConfigOverview = {
  runtime: { id: string; name: string; kind: string };
  files: { preference: { path: string; exists: boolean } | null; config: { path: string; exists: boolean } | null };
  auth: Array<{ path: string; exists: boolean }>;
  mcp: { supported: boolean; format?: string; editable?: boolean; path?: string };
  skills: Array<{ path: string; shared: boolean; absent: boolean; skills: Array<{ name: string; hasSkillFile: boolean }> }>;
};

type Section = 'settings' | 'mcp' | 'skills';

/** 每运行时配置页：原生偏好 / 配置文件、MCP、技能目录。认证文件只显示在不在。 */
export default function RuntimeConfigPage({ runtimeId, section, onBack }: { runtimeId: string; section: Section; onBack: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<ConfigOverview | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    setError(null);
    void (async () => {
      const res = await getRuntimeConfig(runtimeId);
      const data = await readJson(res);
      if (cancelled) return;
      if (!res.ok) setError(resolveApiErrorMessage(data, t, 'runtimes.loadFailed'));
      else setOverview(data);
    })();
    return () => { cancelled = true; };
  }, [runtimeId]);

  const setSection = (next: Section) => navigate(`/settings/runtimes?runtime=${encodeURIComponent(runtimeId)}${next === 'settings' ? '' : `&section=${next}`}`, { replace: true });
  const sections: Section[] = ['settings', ...(overview?.mcp.supported ? ['mcp' as const] : []), 'skills'];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="w-4 h-4" />{t('runtimes.config.back')}</Button>
        <h3 className="text-lg font-semibold text-gray-900">{overview?.runtime.name ?? runtimeId}</h3>
      </div>

      <ErrorBanner error={error} />

      <div className="flex gap-1 p-1 bg-gray-100/70 rounded-xl w-fit max-w-full overflow-x-auto">
        {sections.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setSection(item)}
            className={`px-3 py-1.5 text-sm rounded-lg border whitespace-nowrap transition-colors ${section === item ? 'bg-white border-gray-200 font-semibold text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {t(`runtimes.config.sections.${item}`)}
          </button>
        ))}
      </div>

      {overview && section === 'settings' && (
        <div className="space-y-4">
          {overview.auth.length > 0 && (
            <Card className="p-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <KeyRound className="w-4 h-4 text-gray-400" />
              <span>{t('runtimes.config.authFiles')}</span>
              {overview.auth.map((file) => (
                <Badge key={file.path} tone={file.exists ? 'green' : 'gray'}>
                  <span className="font-mono">{file.path}</span>&nbsp;{file.exists ? t('runtimes.config.present') : t('runtimes.config.absent')}
                </Badge>
              ))}
              <span className="text-gray-400">{t('runtimes.config.authNotEditable')}</span>
            </Card>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {overview.files.preference && <NativeFileEditor runtimeId={runtimeId} fileKey="preference" title={t('runtimes.config.preference')} />}
            {overview.files.config && <NativeFileEditor runtimeId={runtimeId} fileKey="config" title={t('runtimes.config.configuration')} />}
          </div>
          {!overview.files.preference && !overview.files.config && <Card className="py-8 text-center text-sm text-gray-400">{t('runtimes.config.noFiles')}</Card>}
        </div>
      )}

      {overview && section === 'mcp' && overview.mcp.supported && <McpPanel runtimeId={runtimeId} />}

      {overview && section === 'skills' && (
        <div className="space-y-3">
          {overview.skills.length === 0 && <Card className="py-8 text-center text-sm text-gray-400">{t('runtimes.skills.none')}</Card>}
          {overview.skills.map((root) => (
            <Card key={root.path} className="p-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-mono text-gray-700 truncate">{root.path}</span>
                {root.shared && <Badge tone="blue">{t('runtimes.skills.sharedReadOnly')}</Badge>}
                {root.absent && <Badge>{t('runtimes.config.absent')}</Badge>}
              </div>
              {root.skills.length === 0 ? (
                <div className="text-xs text-gray-400">{t('runtimes.skills.empty')}</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {root.skills.map((skill) => <Badge key={skill.name} tone={skill.hasSkillFile ? 'gray' : 'amber'}>{skill.name}</Badge>)}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
