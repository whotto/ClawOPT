// 画布上的 Agent 节点：标题、Agent 选择、任务输入、技能、附件、汇合方式、审批闸门，四个方向的连接点。
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Loader2, Paperclip, ShieldCheck, X } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadFiles } from '../../../api/files';
import type { CanvasNode } from '../hooks/useWorkflowEditor';
import type { AgentRef } from '../lib/types';
import { agentKey, useCanvasContext } from './canvasContext';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  queued: 'bg-gray-300',
  pending_approval: 'bg-amber-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  approval_rejected: 'bg-red-500',
  canceled: 'bg-gray-400',
  skipped: 'bg-gray-200',
  idle: 'bg-gray-200',
};

const STATUS_FRAME: Record<string, string> = {
  running: 'border-blue-400',
  pending_approval: 'border-orange-400',
  completed: 'border-green-300',
  failed: 'border-red-300',
  approval_rejected: 'border-red-300',
  skipped: 'border-dashed border-gray-300 opacity-60',
};

const HANDLE_CLASS = '!w-2.5 !h-2.5 !bg-white !border !border-gray-400';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function AgentNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const { t } = useTranslation();
  const canvas = useCanvasContext();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const editable = canvas.mode === 'edit';
  const status = canvas.statusOf(id);
  const error = canvas.errorOf(id);
  const agentEntry = canvas.agents.find((entry) => agentKey(entry.ref) === agentKey(data.agent));
  const change = (patch: Parameters<typeof canvas.onChange>[1]) => canvas.onChange(id, patch);

  const onPickAgent = (value: string) => {
    const entry = canvas.agents.find((item) => agentKey(item.ref) === value);
    if (!entry) return;
    const agent: AgentRef = entry.ref.kind === 'external' ? { kind: 'external', id: entry.ref.id, runtime: entry.ref.id } : { kind: 'openclaw', id: entry.ref.id };
    change({ agent, skills: data.skills.filter((skill) => entry.skills.includes(skill)) });
  };

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      const response = await uploadFiles(form);
      const body = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body?.files)) {
        change({ attachments: [...data.attachments, ...body.files.map((file: { name: string; url: string; mimeType?: string }) => ({ name: file.name, url: file.url, mimeType: file.mimeType }))].slice(0, 20) });
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div
      className={`w-[260px] rounded-2xl border bg-white text-left ${selected ? 'border-orange-400' :STATUS_FRAME[status ?? ''] ?? 'border-gray-200'}`}
      onDoubleClick={() => canvas.onOpenNode(id)}
    >
      {(['left', 'top', 'right', 'bottom'] as const).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={{ left: Position.Left, top: Position.Top, right: Position.Right, bottom: Position.Bottom }[side]}
          className={HANDLE_CLASS}
          isConnectable={editable}
        />
      ))}
      <div className="px-3 pt-3 pb-2 border-b border-gray-100 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status ?? 'idle'] ?? STATUS_DOT.idle}`} title={status ? t(`automation.status.${status}`) : ''} />
        {editable ? (
          <input
            className="nodrag min-w-0 flex-1 text-sm font-semibold text-gray-900 bg-transparent focus:outline-none"
            value={data.title}
            onChange={(event) => change({ title: event.target.value })}
            placeholder={t('automation.node.titlePlaceholder')}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">{data.title}</span>
        )}
        {data.approvalRequired && <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" aria-label={t('automation.node.approvalGate')} />}
        {status && status !== 'idle' && <span className="text-[11px] text-gray-500 whitespace-nowrap">{t(`automation.status.${status}`)}</span>}
      </div>
      <div className="px-3 py-2 space-y-2">
        {editable ? (
          <select
            className="nodrag w-full px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-gray-50 focus:outline-none"
            value={agentKey(data.agent)}
            onChange={(event) => onPickAgent(event.target.value)}
          >
            {!agentEntry && <option value={agentKey(data.agent)}>{data.agent.id} · {t('automation.node.agentMissing')}</option>}
            <optgroup label={t('automation.node.openclawAgents')}>
              {canvas.agents.filter((entry) => entry.ref.kind === 'openclaw').map((entry) => (
                <option key={agentKey(entry.ref)} value={agentKey(entry.ref)}>{entry.name}</option>
              ))}
            </optgroup>
            <optgroup label={t('automation.node.externalRuntimes')}>
              {canvas.agents.filter((entry) => entry.ref.kind === 'external').map((entry) => (
                <option key={agentKey(entry.ref)} value={agentKey(entry.ref)} disabled={!entry.available}>
                  {entry.name}{entry.available ? '' : ` · ${t('automation.node.unavailable')}`}
                </option>
              ))}
            </optgroup>
          </select>
        ) : (
          <div className="text-xs text-gray-500 truncate">{agentEntry?.name ?? data.agent.id}</div>
        )}
        {editable ? (
          <textarea
            className="nodrag nowheel w-full min-h-[72px] px-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none resize-y"
            value={data.input}
            onChange={(event) => change({ input: event.target.value })}
            placeholder={t('automation.node.inputPlaceholder')}
          />
        ) : (
          <div className="text-xs text-gray-700 whitespace-pre-wrap line-clamp-4">{data.input}</div>
        )}
        {agentEntry && agentEntry.skills.length > 0 && (editable || data.skills.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {(editable ? agentEntry.skills : data.skills).map((skill) => {
              const on = data.skills.includes(skill);
              return (
                <button
                  key={skill}
                  type="button"
                  disabled={!editable}
                  onClick={() => change({ skills: on ? data.skills.filter((item) => item !== skill) : [...data.skills, skill] })}
                  className={`nodrag px-1.5 py-0.5 text-[11px] rounded-md border ${on ? 'bg-amber-50 border-orange-300 text-gray-700' : 'bg-white border-gray-200 text-gray-400'}`}
                >
                  {skill}
                </button>
              );
            })}
          </div>
        )}
        {data.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.attachments.map((attachment) => (
              <span key={attachment.url} className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 text-[11px] rounded-md border border-gray-200 bg-gray-50 text-gray-600">
                {IMAGE_EXT.test(attachment.name) && <img src={attachment.url} alt="" className="w-4 h-4 rounded object-cover" />}
                <span className="truncate max-w-[140px]">{attachment.name}</span>
                {editable && (
                  <X className="nodrag w-3 h-3 cursor-pointer" onClick={() => change({ attachments: data.attachments.filter((item) => item.url !== attachment.url) })} />
                )}
              </span>
            ))}
          </div>
        )}
        {editable && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <select
              className="nodrag px-2 py-1 text-[11px] rounded-lg border border-gray-200 bg-white focus:outline-none"
              value={data.orchestration.join}
              title={t('automation.node.joinHelp')}
              onChange={(event) => change({ orchestration: { join: event.target.value as 'all' | 'any' } })}
            >
              <option value="all">{t('automation.node.joinAll')}</option>
              <option value="any">{t('automation.node.joinAny')}</option>
            </select>
            <button
              type="button"
              onClick={() => change({ approvalRequired: !data.approvalRequired })}
              className={`nodrag inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border ${data.approvalRequired ? 'bg-amber-50 border-orange-300 text-gray-700' : 'bg-white border-gray-200 text-gray-500'}`}
            >
              <ShieldCheck className="w-3 h-3" />
              {t('automation.node.approvalGate')}
            </button>
            <button type="button" className="nodrag p-1 text-gray-500 hover:text-gray-800" title={t('automation.node.attach')} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
            </button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => void onUpload(event.target.files)} />
          </div>
        )}
        {error && <div className="text-[11px] text-red-600 line-clamp-3" title={error}>{error}</div>}
      </div>
    </div>
  );
}

export default memo(AgentNodeView);
