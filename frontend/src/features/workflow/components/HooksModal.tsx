// 入站钩子：外部系统用签名请求触发工作流。密钥只在创建 / 轮换时显示一次，之后只显示「已设置」。
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createHook, deleteHook, listHooks, rotateHookSecret, updateHook } from '../../../api/automation';
import { describeError, requestJson } from '../lib/request';
import type { HookRecord, WfNode } from '../lib/types';
import { ErrorBanner, Field, InfoBanner, Modal, Toggle, formatTime, iconButton, inputClass, primaryButton } from './ui';

export default function HooksModal({ workflowId, savedNodes, onClose }: { workflowId: string; savedNodes: WfNode[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<HookRecord[]>([]);
  const [name, setName] = useState('');
  const [startNodeIds, setStartNodeIds] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<{ hookId: string; secret: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await requestJson<{ hooks: HookRecord[] }>(listHooks(workflowId));
    if (result.ok) setHooks(result.data.hooks);
  }, [workflowId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const hookUrl = (hookId: string) => `${window.location.origin}/api/hooks/workflows/${hookId}`;

  const create = async () => {
    const result = await requestJson<{ hook: HookRecord; secret: string }>(createHook(workflowId, { name, start_node_ids: startNodeIds }));
    if (!result.ok) return setProblem(describeError(t, result.error));
    setRevealed({ hookId: result.data.hook.id, secret: result.data.secret });
    setName('');
    setStartNodeIds([]);
    void reload();
  };

  const rotate = async (hook: HookRecord) => {
    const result = await requestJson<{ hook: HookRecord; secret: string }>(rotateHookSecret(workflowId, hook.id));
    if (!result.ok) return setProblem(describeError(t, result.error));
    setRevealed({ hookId: hook.id, secret: result.data.secret });
  };

  const exampleFor = (hookId: string, secret: string) => [
    `BODY='{"input":"hello"}'`,
    'TS=$(date +%s)',
    `SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac '${secret}' | sed 's/^.* //')"`,
    `curl -X POST '${hookUrl(hookId)}' -H 'Content-Type: application/json' -H "X-ClawOPT-Timestamp: $TS" -H "X-ClawOPT-Signature-256: $SIG" -d "$BODY"`,
  ].join('\n');

  return (
    <Modal title={t('automation.hooks.title')} onClose={onClose} width="max-w-2xl">
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <InfoBanner>{t('automation.hooks.securityNote')}</InfoBanner>
      {revealed && (
        <div className="p-3 rounded-xl border border-orange-300 bg-amber-50 space-y-2">
          <p className="text-sm font-medium text-gray-900">{t('automation.hooks.secretOnce')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all text-xs font-mono bg-white border border-gray-200 rounded-lg px-2 py-1">{revealed.secret}</code>
            <button className={iconButton} title={t('common.copy')} onClick={() => void navigator.clipboard?.writeText(revealed.secret)}><Copy className="w-4 h-4" /></button>
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-white border border-gray-200 rounded-lg p-2 overflow-x-auto">{exampleFor(revealed.hookId, revealed.secret)}</pre>
        </div>
      )}
      <div className="space-y-2">
        {hooks.length === 0 && <p className="text-sm text-gray-500">{t('automation.hooks.empty')}</p>}
        {hooks.map((hook) => (
          <div key={hook.id} className="p-3 rounded-xl border border-gray-200 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-gray-900 truncate">{hook.name || t('automation.hooks.unnamed')}</span>
              <div className="flex items-center gap-1 shrink-0">
                <Toggle checked={hook.enabled} onChange={async (enabled) => { await requestJson(updateHook(workflowId, hook.id, { enabled })); void reload(); }} label="" />
                <button className={iconButton} title={t('automation.hooks.rotate')} onClick={() => void rotate(hook)}><KeyRound className="w-4 h-4" /></button>
                <button className={iconButton} title={t('common.delete')} onClick={async () => { await requestJson(deleteHook(workflowId, hook.id)); void reload(); }}><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
            <code className="block text-xs font-mono text-gray-600 break-all">{hookUrl(hook.id)}</code>
            <div className="text-xs text-gray-500">
              {t('automation.hooks.secretSet')} · {t('automation.hooks.lastTriggered')}: {formatTime(hook.lastTriggeredAt)}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-100 pt-4 space-y-3">
        <Field label={t('automation.hooks.name')}>
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t('automation.schedules.startNodes')} hint={t('automation.schedules.startNodesHint')}>
          <div className="flex flex-wrap gap-2">
            {savedNodes.map((node) => (
              <label key={node.id} className="inline-flex items-center gap-1 text-sm text-gray-700">
                <input type="checkbox" checked={startNodeIds.includes(node.id)} onChange={(event) => setStartNodeIds(event.target.checked ? [...startNodeIds, node.id] : startNodeIds.filter((id) => id !== node.id))} />
                {node.data.title}
              </label>
            ))}
          </div>
        </Field>
        <button className={primaryButton} onClick={() => void create()}>{t('automation.hooks.create')}</button>
      </div>
    </Modal>
  );
}
