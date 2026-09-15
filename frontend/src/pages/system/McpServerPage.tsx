// ClawOPT MCP 服务（系统区，管理员）：按运行时开关注入、选工具集与可委派目标；看生效中的范围令牌并可吊销；审计每次调用的结果。
// 令牌本身永远不回前端（服务端只存哈希），这里只有它的范围、操作与有效期。
import { Ban, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mcpServerApi, type McpAuditEntry, type McpRuntimeSetting, type McpServerSettings, type McpTokenView, type McpToolset } from '../../api/mcpServer';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, LoadingRow, NoPermissionState, Notice, PageIntro, Toggle, formatTime, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type Draft = { enabled: boolean; toolsets: McpToolset[]; delegateAgents: string[] };

const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = {
  allowed: 'green',
  denied_scope: 'red',
  denied_operation: 'red',
  expired: 'amber',
  revoked: 'amber',
  invalid: 'red',
  failed: 'gray',
};

function sameDraft(a: Draft, b: Draft): boolean {
  return a.enabled === b.enabled && [...a.toolsets].sort().join() === [...b.toolsets].sort().join() && [...a.delegateAgents].sort().join() === [...b.delegateAgents].sort().join();
}

function RuntimeRow({ runtime, settings, onSaved }: { runtime: McpRuntimeSetting; settings: McpServerSettings; onSaved: (next: McpRuntimeSetting) => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const saved: Draft = { enabled: runtime.enabled, toolsets: runtime.toolsets, delegateAgents: runtime.delegateAgents };
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  useEffect(() => {
    setDraft({ enabled: runtime.enabled, toolsets: runtime.toolsets, delegateAgents: runtime.delegateAgents });
  }, [runtime.enabled, runtime.toolsets, runtime.delegateAgents]);

  const toggleToolset = (toolset: McpToolset) => setDraft((current) => ({
    ...current,
    toolsets: current.toolsets.includes(toolset) ? current.toolsets.filter((item) => item !== toolset) : [...current.toolsets, toolset],
  }));
  const toggleDelegate = (agentId: string) => setDraft((current) => ({
    ...current,
    delegateAgents: current.delegateAgents.includes(agentId) ? current.delegateAgents.filter((item) => item !== agentId) : [...current.delegateAgents, agentId],
  }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await readApi<{ runtime: McpRuntimeSetting }>(mcpServerApi.saveRuntime(runtime.id, draft));
      if (result.ok) onSaved({ ...runtime, ...result.data.runtime });
      else setError(errors.fromResult(result, 'mcpServer.page.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
    }
  };

  const dirty = !sameDraft(draft, saved);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">{runtime.name}</span>
        <span className="font-mono text-xs text-gray-400">{runtime.id}</span>
        {runtime.enabled ? <Badge tone="green">{t('mcpServer.page.injected')}</Badge> : <Badge>{t('mcpServer.page.notInjected')}</Badge>}
        <div className="flex-1" />
        <Toggle checked={draft.enabled} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} label={t('mcpServer.page.enable', { runtime: runtime.name })} />
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="space-y-2">
        <div className="text-xs font-medium text-gray-500">{t('mcpServer.page.toolsets')}</div>
        <div className="flex flex-wrap gap-2">
          {settings.toolsets.map((toolset) => (
            <label key={toolset} className={`inline-flex items-center gap-2 h-9 px-3 rounded-xl border text-sm ${draft.toolsets.includes(toolset) ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-gray-200 bg-white text-gray-600'}`}>
              <input type="checkbox" checked={draft.toolsets.includes(toolset)} onChange={() => toggleToolset(toolset)} />
              <span className="font-medium">{t(`mcpServer.toolset.${toolset}.name`)}</span>
            </label>
          ))}
        </div>
        <div className="text-xs text-gray-500 space-y-0.5">
          {draft.toolsets.map((toolset) => <div key={toolset}>{t(`mcpServer.toolset.${toolset}.description`)}</div>)}
        </div>
      </div>
      {draft.toolsets.includes('use') && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500">{t('mcpServer.page.delegates')}</div>
          <p className="text-xs text-gray-500">{t('mcpServer.page.delegatesHint')}</p>
          {!settings.delegationAvailable && <Notice>{t('mcpServer.page.delegationUnavailable')}</Notice>}
          <div className="flex flex-wrap gap-1.5">
            {settings.agentOptions.map((agentId) => (
              <button
                key={agentId}
                type="button"
                aria-pressed={draft.delegateAgents.includes(agentId)}
                onClick={() => toggleDelegate(agentId)}
                className={`h-7 px-2.5 rounded-full border font-mono text-xs ${draft.delegateAgents.includes(agentId) ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-gray-200 bg-white text-gray-500'}`}
              >
                {agentId}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" busy={busy} disabled={!dirty} onClick={() => void save()}><Save className="w-3.5 h-3.5" />{t('common.save')}</Button>
      </div>
    </Card>
  );
}

export default function McpServerPage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [settings, setSettings] = useState<McpServerSettings | null>(null);
  const [tokens, setTokens] = useState<McpTokenView[] | null>(null);
  const [audit, setAudit] = useState<McpAuditEntry[] | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<McpTokenView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResult, tokensResult, auditResult] = await Promise.all([
        readApi<McpServerSettings>(mcpServerApi.settings()),
        readApi<{ tokens: McpTokenView[] }>(mcpServerApi.tokens()),
        readApi<{ entries: McpAuditEntry[] }>(mcpServerApi.audit()),
      ]);
      if (settingsResult.status === 403) {
        setForbidden(true);
        return;
      }
      if (settingsResult.ok) setSettings(settingsResult.data);
      else setError(errors.fromResult(settingsResult, 'mcpServer.page.loadFailed'));
      setTokens(tokensResult.ok ? tokensResult.data.tokens : []);
      setAudit(auditResult.ok ? auditResult.data.entries : []);
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setLoading(false);
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    const result = await readApi(mcpServerApi.revokeToken(target.id)).catch(() => null);
    if (result && !result.ok) setError(errors.fromResult(result, 'mcpServer.page.revokeFailed'));
    void load();
  };

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('mcpServer.page.title')}
        description={t('mcpServer.page.description')}
        actions={<Button onClick={() => void load()} busy={loading}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Notice tone="blue">
        <div className="space-y-1">
          <div className="font-medium flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" />{t('mcpServer.page.scopeTitle')}</div>
          <div>{t('mcpServer.page.scopeToken')}</div>
          <div>{t('mcpServer.page.scopeReach')}</div>
          <div>{t('mcpServer.page.scopeNever')}</div>
        </div>
      </Notice>

      {!settings ? <LoadingRow /> : (
        <div className="space-y-3">
          <h4 className="text-base font-semibold text-gray-900">{t('mcpServer.page.runtimesTitle')}</h4>
          {settings.runtimes.length === 0 ? <EmptyState>{t('mcpServer.page.noRuntimes')}</EmptyState> : settings.runtimes.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              settings={settings}
              onSaved={(next) => setSettings((current) => (current ? { ...current, runtimes: current.runtimes.map((item) => (item.id === next.id ? next : item)) } : current))}
            />
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{t('mcpServer.page.tokensTitle')}</div>
        {tokens === null ? <LoadingRow /> : tokens.length === 0 ? <div className="px-4 py-6 text-center text-sm text-gray-400">{t('mcpServer.page.noTokens')}</div> : (
          <div className="overflow-x-auto">
            <table className="min-w-[720px] w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colRuntime')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colScope')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colOperations')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colExpires')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-t border-gray-100 align-top">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs">{token.runtime}</div>
                      <div className="text-xs text-gray-400">{t(`mcpServer.surface.${token.surface}`)}</div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 max-w-[16rem]">
                      <div className="truncate">{token.scope.agentIds.join(', ')}</div>
                      <div className="truncate text-gray-400">{token.sessionKey}</div>
                      {token.scope.delegated && <Badge tone="amber">{t('mcpServer.page.delegated')}</Badge>}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{t('mcpServer.page.operationCount', { count: token.operations.length })}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 font-mono">{formatTime(token.expiresAt, i18n.language)}</td>
                    <td className="px-4 py-2 text-right"><Button size="sm" variant="danger" onClick={() => setRevoking(token)}><Ban className="w-3.5 h-3.5" />{t('mcpServer.page.revoke')}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{t('mcpServer.page.auditTitle')}</div>
        {audit === null ? <LoadingRow /> : audit.length === 0 ? <div className="px-4 py-6 text-center text-sm text-gray-400">{t('mcpServer.page.noAudit')}</div> : (
          <div className="overflow-x-auto max-h-[28rem]">
            <table className="min-w-[640px] w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                <tr>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colTime')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colOperation')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colOutcome')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colAgent')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('mcpServer.page.colDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id} className="border-t border-gray-100">
                    <td className="px-4 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">{formatTime(entry.ts, i18n.language)}</td>
                    <td className="px-4 py-2 font-mono text-xs">{entry.operation}</td>
                    <td className="px-4 py-2"><Badge tone={OUTCOME_TONE[entry.outcome] ?? 'gray'}>{t(`mcpServer.outcome.${entry.outcome}`)}</Badge></td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600">{entry.runtime ? `${entry.runtime} · ${entry.agentId ?? ''}` : '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-400 max-w-[16rem] truncate">{entry.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {revoking && (
        <ConfirmDialog
          title={t('mcpServer.page.revoke')}
          message={t('mcpServer.page.revokeConfirm', { runtime: revoking.runtime, session: revoking.sessionKey })}
          confirmLabel={t('mcpServer.page.revoke')}
          onConfirm={() => void revoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
