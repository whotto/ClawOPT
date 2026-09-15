/**
 * 远程协作 · 把本机 Agent 接进别人的群（P3 任务 9 的 target 侧，管理员）。
 *
 * 流程：对方在群里生成配对码 → 这里粘贴配对码、选本机运行时、起个在那个群里显示的名字 → 提交后等对方房间归属人批准
 * → 批准后本机保持一条 WebSocket 长连接；对方 @ 这个名字时，运行在**本机**，凭据只在本机加密保存。
 */
import { Link2, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Card, inputClass } from '../../components/control/ControlUi';
import { chatCapableRuntimes, runtimeOptionLabel, type RuntimeOption } from '../../components/runtime/runtimeSelection';
import { listMemberRuntimes } from '../../api/runtime';
import { RoomApiError, relayLinksApi, type RelayLink } from './api';

export default function RelayLinksPanel() {
  const { t } = useTranslation();
  const [links, setLinks] = useState<RelayLink[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [form, setForm] = useState({ pairingCode: '', runtime: '', name: '', description: '', mode: 'global' as 'global' | 'scoped', model: '', trustedLan: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => { relayLinksApi.list().then((result) => setLinks(result.links)).catch(() => setLinks([])); }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    listMemberRuntimes().then((res) => res.json()).then((data) => {
      const options = Array.isArray(data?.runtimes) ? chatCapableRuntimes(data.runtimes) : [];
      setRuntimes(options);
      setForm((prev) => ({ ...prev, runtime: prev.runtime || options[0]?.id || '' }));
    }).catch(() => {});
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); load(); } catch (err) {
      setError(err instanceof RoomApiError ? String(t(err.code, { defaultValue: err.message })) : String((err as Error)?.message ?? err));
    } finally { setBusy(false); }
  };

  const tone = (link: RelayLink) => (link.connected ? 'green' : link.status === 'pending_approval' ? 'amber' : link.status === 'revoked' || link.status === 'failed' ? 'red' : 'gray');

  return (
    <Card className="p-4 sm:p-5 space-y-4" >
      <div className="flex items-center gap-2">
        <PlugZap className="w-5 h-5 text-blue-600" />
        <h3 className="text-base font-bold text-gray-900 flex-1">{t('rooms.links.title')}</h3>
        <Button onClick={() => setOpen((value) => !value)}>{t(open ? 'common.cancel' : 'rooms.links.add')}</Button>
      </div>
      <p className="text-xs text-gray-500">{t('rooms.links.hint')}</p>
      {open && (
        <div className="space-y-2 rounded-xl border border-gray-200 p-3" data-testid="relay-link-form">
          <label className="block text-sm">{t('rooms.links.pairingCode')}
            <textarea value={form.pairingCode} onChange={(event) => setForm({ ...form, pairingCode: event.target.value.trim() })} className={`${inputClass} h-20 font-mono text-[11px]`} data-testid="relay-link-code" />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block text-sm">{t('rooms.links.runtime')}
              <select value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value })} className={inputClass}>
                {runtimes.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtimeOptionLabel(runtime, t)}</option>)}
              </select>
            </label>
            <label className="block text-sm">{t('rooms.links.name')}
              <input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} className={inputClass} />
            </label>
            <label className="block text-sm">{t('rooms.links.description')}
              <input value={form.description} maxLength={200} onChange={(event) => setForm({ ...form, description: event.target.value })} className={inputClass} />
            </label>
            <label className="block text-sm">{t('rooms.links.model')}
              <input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} className={inputClass} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.trustedLan} onChange={(event) => setForm({ ...form, trustedLan: event.target.checked })} />{t('rooms.links.trustedLan')}</label>
          <Button variant="primary" busy={busy} disabled={!form.pairingCode || !form.runtime || !form.name.trim()} onClick={() => act(async () => {
            await relayLinksApi.create({ ...form, description: form.description || undefined, model: form.model || undefined });
            setForm({ ...form, pairingCode: '', name: '', description: '' });
            setOpen(false);
          })}>{t('rooms.links.submit')}</Button>
        </div>
      )}
      <ul className="space-y-2">
        {links.length === 0 && <li className="text-sm text-gray-400">{t('rooms.links.empty')}</li>}
        {links.map((link) => (
          <li key={link.id} className="rounded-xl border border-gray-200 px-3 py-2 flex flex-wrap items-center gap-2" data-testid="relay-link-row">
            <Link2 className="w-4 h-4 text-gray-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">{link.descriptor.name} → {link.roomName}</p>
              <p className="text-xs text-gray-500 truncate">{link.hostUrl} · {t(`externalAgent.runtimeName.${link.descriptor.runtime}`, { defaultValue: link.descriptor.runtime })}{link.lastError ? ` · ${link.lastError}` : ''}</p>
            </div>
            <Badge tone={tone(link)}>{t(`rooms.links.status.${link.status}`, { defaultValue: link.status })}</Badge>
            <button type="button" onClick={() => act(() => relayLinksApi.reconnect(link.id))} className="p-1.5 text-gray-400 hover:text-blue-600" title={t('rooms.links.reconnect')}><RefreshCw className="w-4 h-4" /></button>
            <button type="button" onClick={() => act(() => relayLinksApi.remove(link.id))} className="p-1.5 text-gray-400 hover:text-red-600" title={t('rooms.links.remove')}><Trash2 className="w-4 h-4" /></button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Card>
  );
}
