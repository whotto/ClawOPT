import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search, X } from 'lucide-react';
import { deleteRuntimeMcp, listRuntimeMcp, saveRuntimeMcp, testRuntimeMcp } from '../../../api/runtime';
import { resolveApiErrorMessage, type ErrorDisplay } from './runtimeLogic';
import { Badge, Button, Card, ErrorBanner, editorClass, inputClass, readJson } from './runtimeUi';

type McpServer = { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled: boolean; managed: boolean };
type ProbeResult = { ok: boolean; tools: Array<{ name: string }>; error: string | null };

function toEditText(server: McpServer): string {
  const config: Record<string, unknown> = server.transport === 'http'
    ? { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
    : { command: server.command, ...(server.args?.length ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
  if (!server.enabled) config.enabled = false;
  return JSON.stringify({ [server.name]: config }, null, 2);
}

/** MCP 面板：列表 / 搜索 / 新增与编辑（JSON 或 YAML 的 { name: config }）/ 测试 / 删除；托管条目只读。 */
export default function McpPanel({ runtimeId }: { runtimeId: string }) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [meta, setMeta] = useState<{ path: string; format: string; editable: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [editor, setEditor] = useState<{ text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({});
  const generation = useRef(0);

  const load = async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const res = await listRuntimeMcp(runtimeId);
      const data = await readJson(res);
      if (gen !== generation.current) return;
      if (!res.ok) {
        setError(resolveApiErrorMessage(data, t, 'runtimes.loadFailed'));
        return;
      }
      setServers(data.servers ?? []);
      setMeta({ path: data.path, format: data.format, editable: data.editable });
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    setProbes({});
    void load();
  }, [runtimeId]);

  const filtered = useMemo(() => servers.filter((server) => `${server.name} ${server.transport}`.toLowerCase().includes(query.toLowerCase())), [servers, query]);

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const res = await saveRuntimeMcp(runtimeId, editor.text);
      const data = await readJson(res);
      if (!res.ok) {
        setError(resolveApiErrorMessage(data, t, 'runtimes.saveFailed'));
        return;
      }
      setServers(data.servers ?? []);
      setEditor(null);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    const res = await deleteRuntimeMcp(runtimeId, name);
    const data = await readJson(res);
    if (!res.ok) setError(resolveApiErrorMessage(data, t, 'runtimes.saveFailed'));
    else setServers(data.servers ?? []);
  };

  const test = async (name: string) => {
    const gen = generation.current;
    setProbes((prev) => ({ ...prev, [name]: 'running' }));
    const res = await testRuntimeMcp(runtimeId, name);
    const data = await readJson(res);
    if (gen !== generation.current) return;
    setProbes((prev) => ({ ...prev, [name]: res.ok ? data.result : { ok: false, tools: [], error: resolveApiErrorMessage(data, t, 'runtimes.operationFailed').message } }));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input className={`${inputClass} pl-9`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('runtimes.mcp.search')} />
        </div>
        <span className="text-xs text-gray-500">{t('runtimes.mcp.counts', { total: servers.length, enabled: servers.filter((s) => s.enabled).length, managed: servers.filter((s) => s.managed).length })}</span>
        <Button size="sm" variant="primary" disabled={!meta?.editable} onClick={() => setEditor({ text: '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "some-mcp-server"]\n  }\n}' })}>
          <Plus className="w-3.5 h-3.5" />{t('runtimes.mcp.add')}
        </Button>
      </div>
      {meta && <div className="text-xs text-gray-500 font-mono truncate" title={meta.path}>{meta.path}</div>}
      {meta && !meta.editable && <div className="text-xs text-amber-700">{t('runtimes.mcp.readOnlyFormat')}</div>}
      <ErrorBanner error={error} onClose={() => setError(null)} />

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-400">{t('runtimes.loading')}</div>
      ) : filtered.length === 0 ? (
        <Card className="py-8 text-center text-sm text-gray-400">{t('runtimes.mcp.empty')}</Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((server) => {
            const probe = probes[server.name];
            return (
              <Card key={server.name} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900 truncate">{server.name}</span>
                    <Badge>{server.transport}</Badge>
                    {server.managed && <Badge tone="blue">{t('runtimes.mcp.managed')}</Badge>}
                    <Badge tone={server.enabled ? 'green' : 'gray'}>{server.enabled ? t('runtimes.mcp.enabled') : t('runtimes.mcp.disabled')}</Badge>
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate mt-0.5">{server.transport === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}</div>
                  {probe && probe !== 'running' && (
                    <div className={`text-xs mt-1 ${probe.ok ? 'text-green-700' : 'text-red-600'}`}>
                      {probe.ok ? t('runtimes.mcp.tools', { count: probe.tools.length }) : probe.error}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" busy={probe === 'running'} disabled={!server.enabled} onClick={() => void test(server.name)}>{t('runtimes.mcp.test')}</Button>
                  <Button size="sm" disabled={server.managed || !meta?.editable} onClick={() => setEditor({ text: toEditText(server) })}>{t('common.edit')}</Button>
                  <Button size="sm" variant="danger" disabled={server.managed || !meta?.editable} onClick={() => void remove(server.name)}>{t('runtimes.mcp.remove')}</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editor && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setEditor(null)} />
          <div className="relative z-10 w-full max-w-xl bg-white rounded-2xl border border-gray-200 flex flex-col max-h-[calc(100dvh-2rem)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">{t('runtimes.mcp.editorTitle')}</h3>
              <button type="button" onClick={() => setEditor(null)} className="p-1.5 rounded-lg hover:bg-gray-100" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-2 overflow-y-auto">
              <p className="text-xs text-gray-500">{t('runtimes.mcp.editorHint')}</p>
              <textarea className={editorClass} spellCheck={false} value={editor.text} onChange={(event) => setEditor({ text: event.target.value })} />
            </div>
            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <Button onClick={() => setEditor(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={saving} onClick={() => void save()}>{t('common.save')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
