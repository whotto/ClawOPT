import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRemoteMemberSecret, testRemoteOpenClaw } from '../../api/runtime';
import { MODAL_FIELD_LABEL_CLASS, MODAL_TEXT_INPUT_CLASS, type GroupMemberDraft, type MemberRuntimeOption } from './sidebarTypes';

type TestState = { status: 'idle' | 'running' | 'ok' | 'failed'; message: string };

/**
 * 群成员的运行时：OpenClaw（默认）/ 本机外部 CLI（登记了适配器的）/ 远程 OpenClaw 网关上的 Agent。
 * 远程成员的令牌**只写**：输入框永远是空的，已保存时占位提示「已保存，留空不修改」；保存群之后才写进加密存储。
 */
export default function MemberRuntimeSection({ member, runtimes, groupId, onChange }: {
  member: GroupMemberDraft;
  runtimes: MemberRuntimeOption[];
  groupId: string;
  onChange: (patch: Partial<GroupMemberDraft>) => void;
}) {
  const { t } = useTranslation();
  const runtime = member.runtime || 'openclaw';
  const option = runtimes.find((item) => item.id === runtime);
  const isRemote = option?.kind === 'remote';
  const config = member.externalConfig ?? {};
  const [test, setTest] = useState<TestState>({ status: 'idle', message: '' });

  useEffect(() => {
    setTest({ status: 'idle', message: '' });
    if (!isRemote || !groupId || member.hasRemoteToken !== undefined) return;
    let cancelled = false;
    void getRemoteMemberSecret(groupId, member.agentId).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok) onChange({ hasRemoteToken: Boolean(data.hasToken) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [member.agentId, runtime, groupId]);

  const setConfig = (key: string, value: unknown) => onChange({ externalConfig: { ...config, [key]: value } });

  const runTest = async () => {
    setTest({ status: 'running', message: '' });
    try {
      const res = await testRemoteOpenClaw({
        gatewayUrl: String(config.gatewayUrl ?? ''),
        token: member.remoteToken || undefined,
        trustedLan: config.trustedLan === true,
        remoteAgentId: String(config.remoteAgentId ?? ''),
        groupId: groupId || undefined,
        agentId: member.agentId,
      });
      const data = await res.json().catch(() => ({}));
      const result = data.result;
      if (!res.ok || !result) {
        setTest({ status: 'failed', message: data.errorCode ? t(data.errorCode) : t('sidebar.netError') });
      } else if (result.ok) {
        setTest({ status: 'ok', message: result.agents?.length ? t('remoteOpenclaw.testOkAgents', { agents: result.agents.join(', ') }) : t('remoteOpenclaw.testOk') });
      } else {
        setTest({ status: 'failed', message: `${t(result.messageCode)}${result.detail ? ` · ${result.detail}` : ''}` });
      }
    } catch {
      setTest({ status: 'failed', message: t('sidebar.netError') });
    }
  };

  return (
    <div className="border-t border-gray-100 p-4 space-y-3 bg-white/60">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <label className="text-sm font-semibold text-gray-700 shrink-0">{t('groupRuntime.label')}</label>
        <select
          className={`${MODAL_TEXT_INPUT_CLASS} sm:max-w-xs`}
          value={runtime}
          onChange={(event) => onChange({ runtime: event.target.value, externalConfig: event.target.value === runtime ? config : {} })}
        >
          <option value="openclaw">{t('groupRuntime.openclaw')}</option>
          {runtimes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.kind === 'remote' ? t('groupRuntime.remoteOption') : item.available ? item.name : t('groupRuntime.notInstalledOption', { name: item.name })}
            </option>
          ))}
        </select>
      </div>

      {option && option.kind !== 'remote' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.workingDir')}</label>
            <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.workingDir ?? '')} onChange={(event) => setConfig('workingDir', event.target.value)} placeholder="/srv/project" />
          </div>
          <div>
            <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.model')}</label>
            <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.model ?? '')} onChange={(event) => setConfig('model', event.target.value)} placeholder={t('groupRuntime.modelPlaceholder')} />
          </div>
          {!option.available && <p className="sm:col-span-2 text-xs text-amber-700">{t('groupRuntime.notInstalledHint')}</p>}
        </div>
      )}

      {isRemote && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('remoteOpenclaw.gatewayUrl')}</label>
              <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.gatewayUrl ?? '')} onChange={(event) => setConfig('gatewayUrl', event.target.value.trim())} placeholder="wss://gateway.example.com" />
            </div>
            <div>
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('remoteOpenclaw.remoteAgentId')}</label>
              <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.remoteAgentId ?? '')} onChange={(event) => setConfig('remoteAgentId', event.target.value.trim())} placeholder="main" />
            </div>
            <div className="sm:col-span-2">
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('remoteOpenclaw.token')}</label>
              <input
                className={MODAL_TEXT_INPUT_CLASS}
                type="password"
                autoComplete="new-password"
                value={member.remoteToken ?? ''}
                onChange={(event) => onChange({ remoteToken: event.target.value })}
                placeholder={member.hasRemoteToken ? t('remoteOpenclaw.tokenSaved') : t('remoteOpenclaw.tokenPlaceholder')}
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-1" checked={config.trustedLan === true} onChange={(event) => setConfig('trustedLan', event.target.checked)} />
            <span>
              {t('remoteOpenclaw.trustedLan')}
              <span className="block text-xs text-gray-400">{t('remoteOpenclaw.trustedLanHint')}</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={test.status === 'running' || !config.gatewayUrl}
              className="h-9 px-4 rounded-xl text-sm font-medium bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
            >
              {test.status === 'running' ? t('remoteOpenclaw.testing') : t('remoteOpenclaw.test')}
            </button>
            {test.message && <span className={`text-xs ${test.status === 'ok' ? 'text-green-700' : 'text-red-600'} break-all`}>{test.message}</span>}
          </div>
          <p className="text-xs text-gray-400">{t('remoteOpenclaw.pairingHint')}</p>
        </div>
      )}
    </div>
  );
}
