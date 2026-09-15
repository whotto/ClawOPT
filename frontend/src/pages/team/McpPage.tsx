// MCP 服务器管理（团队区）：列表 + 状态、JSON 编辑（env / headers 的值是占位符，留着即保持原值）、探测、重载、删除。
import { Pencil, Plus, RefreshCw, RotateCw, Stethoscope, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mcpApi } from '../../api/control';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, Notice, PageIntro, textareaClass, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';

type McpServer = { name: string; config: Record<string, unknown>; transport: string | null; enabled: boolean; ok: boolean | null; launch: string | null; revision: string };

const TEMPLATE = JSON.stringify({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }, null, 2);

/** 本地校验，只挡明显错误；真正的判据在后端（同一组 errorCode）。 */
export function validateMcpDraft(text: string): { config: Record<string, unknown> | null; errorKey: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: null, errorKey: 'control.mcp.invalidJson' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: null, errorKey: 'mcp.invalidConfig' };
  const record = parsed as Record<string, unknown>;
  const hasCommand = typeof record.command === 'string' && record.command.trim() !== '';
  const hasUrl = typeof record.url === 'string' && record.url.trim() !== '';
  if (!hasCommand && !hasUrl) return { config: null, errorKey: 'mcp.commandOrUrlRequired' };
  return { config: record, errorKey: null };
}

function ServerModal({ server, onClose, onSaved }: { server: McpServer | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [name, setName] = useState(server?.name ?? '');
  const [text, setText] = useState(server ? JSON.stringify(server.config, null, 2) : TEMPLATE);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = validateMcpDraft(text);

  const save = async () => {
    if (!draft.config) return;
    setSaving(true);
    setError(null);
    try {
      const result = await readApi(mcpApi.save(name.trim(), draft.config, { create: !server, revision: server?.revision }));
      if (result.ok) onSaved();
      else if (result.status === 412) setConflict(true);
      else setError(errors.fromResult(result, 'control.mcp.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={server ? t('control.mcp.editTitle', { name: server.name }) : t('control.mcp.createTitle')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={saving} disabled={!name.trim() || !!draft.errorKey || conflict} onClick={save}>{t('common.save')}</Button>
        </>
      )}
    >
      {conflict && <Notice>{t('control.common.changedElsewhere')}</Notice>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <label className="block">
        <span className={labelClass}>{t('control.mcp.name')}</span>
        <input value={name} disabled={!!server} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="context7" />
      </label>
      <label className="block">
        <span className={labelClass}>{t('control.mcp.configJson')}</span>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={12} spellCheck={false} className={`${textareaClass} text-xs`} />
      </label>
      {draft.errorKey ? <p className="text-xs text-red-500">{t(draft.errorKey)}</p> : <p className="text-xs text-gray-400">{t('control.mcp.secretHint')}</p>}
    </Modal>
  );
}

export default function McpPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [probe, setProbe] = useState<{ name: string; result: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await readApi<{ servers: McpServer[] }>(mcpApi.list());
      if (result.ok) setServers(result.data.servers);
      else {
        setServers([]);
        setError(errors.fromResult(result, 'control.mcp.loadFailed'));
      }
    } catch (exception) {
      setServers([]);
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<Response>, onOk: (data: Record<string, unknown>) => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi<Record<string, unknown>>(request());
      if (result.ok) onOk(result.data);
      else setError(errors.fromResult(result));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.mcp.title')}
        description={t('control.mcp.description')}
        actions={(
          <>
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {isAdmin && <Button busy={busy === 'reload'} onClick={() => void run('reload', mcpApi.reload, () => setNotice(t('control.mcp.reloaded')))}><RotateCw className="w-4 h-4" />{t('control.mcp.reload')}</Button>}
            {isAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" />{t('control.mcp.create')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}

      {servers === null ? <LoadingRow /> : servers.length === 0 ? <EmptyState>{t('control.mcp.empty')}</EmptyState> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {servers.map((server) => (
            <Card key={server.name} className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900 break-all">{server.name}</span>
                <Badge tone={server.enabled ? 'green' : 'gray'}>{server.enabled ? t('control.mcp.enabled') : t('control.mcp.disabled')}</Badge>
                {server.transport && <Badge>{server.transport}</Badge>}
                {server.ok === false && <Badge tone="red">{t('control.mcp.configProblem')}</Badge>}
              </div>
              <div className="text-xs font-mono text-gray-500 break-all">{String(server.config.url ?? server.launch ?? server.config.command ?? '')}</div>
              <div className="flex flex-wrap gap-2">
                {isAdmin && <Button size="sm" busy={busy === `probe:${server.name}`} onClick={() => void run(`probe:${server.name}`, () => mcpApi.probe(server.name), (data) => setProbe({ name: server.name, result: data.probe }))}><Stethoscope className="w-3.5 h-3.5" />{t('control.mcp.probe')}</Button>}
                {isAdmin && <Button size="sm" onClick={() => setEditing(server)}><Pencil className="w-3.5 h-3.5" />{t('common.edit')}</Button>}
                {isAdmin && <Button size="sm" variant="danger" onClick={() => setDeleting(server)}><Trash2 className="w-3.5 h-3.5" />{t('common.delete')}</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && <ServerModal server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {deleting && (
        <ConfirmDialog
          title={t('common.confirmDelete')}
          message={t('control.mcp.confirmDelete', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          busy={busy === `delete:${deleting.name}`}
          onConfirm={() => void run(`delete:${deleting.name}`, () => mcpApi.remove(deleting.name), () => { setDeleting(null); void load(); })}
          onCancel={() => setDeleting(null)}
        />
      )}
      {probe && (
        <Modal title={t('control.mcp.probeTitle', { name: probe.name })} onClose={() => setProbe(null)}>
          <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{JSON.stringify(probe.result, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}
