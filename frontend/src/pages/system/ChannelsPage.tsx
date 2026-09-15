// 频道（系统区）：已配置频道 + 状态、按需探测、添加 / 更新账号（凭据只写不读）、登录 / 登出、清空凭据、移除、能力查看。
import { Eraser, Info, LogIn, LogOut, Plus, Radar, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { channelsApi } from '../../api/control';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';

type Channel = { id: string; installed: boolean; origin: string | null; accounts: Array<Record<string, unknown>> };

const SECRET_FIELDS = ['botToken', 'appToken', 'password', 'secret'] as const;

function AddChannelModal({ catalog, initialChannel, onClose, onSaved }: { catalog: string[]; initialChannel: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [form, setForm] = useState<Record<string, string>>({ channel: initialChannel || catalog[0] || 'telegram', account: '', name: '', botToken: '', appToken: '', password: '', secret: '', baseUrl: '' });
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await readApi(channelsApi.add(form));
      if (result.ok) onSaved();
      else setError(errors.fromResult(result, 'control.channels.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('control.channels.addTitle')}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={saving} onClick={save}>{t('common.save')}</Button></>}
    >
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Notice tone="blue">{t('control.channels.secretHint')}</Notice>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block">
          <span className={labelClass}>{t('control.channels.channel')}</span>
          <select value={form.channel} onChange={(event) => patch('channel', event.target.value)} className={inputClass}>
            {catalog.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>{t('control.channels.account')}</span>
          <input value={form.account} onChange={(event) => patch('account', event.target.value)} className={inputClass} placeholder="default" />
        </label>
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t('control.channels.displayName')}</span>
          <input value={form.name} onChange={(event) => patch('name', event.target.value)} className={inputClass} />
        </label>
        {SECRET_FIELDS.map((field) => (
          <label key={field} className="block">
            <span className={labelClass}>{t(`control.channels.field.${field}`)}</span>
            <input type="password" autoComplete="new-password" value={form[field]} onChange={(event) => patch(field, event.target.value)} className={inputClass} placeholder={t('control.channels.leaveBlankKeep')} />
          </label>
        ))}
        <label className="block sm:col-span-2">
          <span className={labelClass}>{t('control.channels.baseUrl')}</span>
          <input value={form.baseUrl} onChange={(event) => patch('baseUrl', event.target.value)} className={inputClass} />
        </label>
      </div>
      <p className="text-xs text-gray-400">{t('control.channels.exclusiveTokenHint')}</p>
    </Modal>
  );
}

export default function ChannelsPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'clear' | 'remove'; channel: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [capabilities, setCapabilities] = useState<{ channel: string; data: unknown } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [configured, all, current] = await Promise.all([
        readApi<{ channels: Channel[] }>(channelsApi.list(false)),
        readApi<{ channels: Channel[] }>(channelsApi.list(true)),
        readApi<{ status: Record<string, unknown> }>(channelsApi.status()),
      ]);
      if (configured.ok) setChannels(configured.data.channels);
      else {
        setChannels([]);
        setError(errors.fromResult(configured, 'control.channels.loadFailed'));
      }
      if (all.ok) setCatalog(all.data.channels.map((channel) => channel.id).sort());
      if (current.ok) setStatus(current.data.status);
    } catch (exception) {
      setChannels([]);
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<Response>, onOk?: (data: Record<string, unknown>) => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi<Record<string, unknown>>(request());
      if (result.ok) {
        onOk?.(result.data);
        await load();
      } else setError(errors.fromResult(result));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const channelStatus = (id: string) => {
    const entry = (status?.channels as Record<string, Record<string, unknown>> | undefined)?.[id];
    if (!entry) return null;
    return entry;
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.channels.title')}
        description={t('control.channels.description')}
        actions={(
          <>
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {isAdmin && <Button busy={busy === 'probe'} onClick={() => void run('probe', channelsApi.probe, (data) => setStatus(data.status as Record<string, unknown>))}><Radar className="w-4 h-4" />{t('control.channels.probe')}</Button>}
            {isAdmin && <Button variant="primary" onClick={() => setAdding('')}><Plus className="w-4 h-4" />{t('control.channels.add')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}

      {channels === null ? <LoadingRow /> : channels.length === 0 ? <EmptyState>{t('control.channels.empty')}</EmptyState> : (
        <div className="space-y-3">
          {channels.map((channel) => {
            const state = channelStatus(channel.id);
            return (
              <Card key={channel.id} className="p-4 space-y-3">
                <div className="flex flex-col md:flex-row md:items-center gap-3">
                  <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900">{channel.id}</span>
                    {channel.origin && <Badge tone="blue">{channel.origin}</Badge>}
                    {state ? <Badge tone={state.running === true || state.connected === true ? 'green' : 'amber'}>{String(state.state ?? (state.running ? t('control.channels.running') : t('control.channels.stopped')))}</Badge> : <Badge>{t('control.channels.noStatus')}</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void run(`cap:${channel.id}`, () => channelsApi.capabilities(channel.id), (data) => setCapabilities({ channel: channel.id, data: data.capabilities }))}><Info className="w-3.5 h-3.5" />{t('control.channels.capabilities')}</Button>
                    {isAdmin && (
                      <>
                        <Button size="sm" onClick={() => setAdding(channel.id)}><Plus className="w-3.5 h-3.5" />{t('control.channels.updateAccount')}</Button>
                        <Button size="sm" busy={busy === `login:${channel.id}`} onClick={() => void run(`login:${channel.id}`, () => channelsApi.login(channel.id), (data) => setNotice(String(data.output || t('control.channels.loginDone'))))}><LogIn className="w-3.5 h-3.5" />{t('control.channels.login')}</Button>
                        <Button size="sm" busy={busy === `logout:${channel.id}`} onClick={() => void run(`logout:${channel.id}`, () => channelsApi.logout(channel.id), () => setNotice(t('control.channels.loggedOut')))}><LogOut className="w-3.5 h-3.5" />{t('control.channels.logout')}</Button>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'clear', channel: channel.id })}><Eraser className="w-3.5 h-3.5" />{t('control.channels.clearCredentials')}</Button>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'remove', channel: channel.id })}><Trash2 className="w-3.5 h-3.5" />{t('control.channels.remove')}</Button>
                      </>
                    )}
                  </div>
                </div>
                {channel.accounts.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {channel.accounts.map((account, index) => (
                      <div key={index} className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-gray-50 text-gray-600">
                        {String(account.accountId ?? account.id ?? account.name ?? `#${index + 1}`)}
                        {Object.entries(account).filter(([key]) => key.startsWith('has')).map(([key, value]) => (
                          <span key={key} className={`ml-2 ${value ? 'text-green-600' : 'text-gray-400'}`}>{key.slice(3)}{value ? ' ✓' : ' —'}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {adding !== null && <AddChannelModal catalog={catalog.length ? catalog : ['telegram']} initialChannel={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); setNotice(t('control.channels.saved')); void load(); }} />}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'clear' ? t('control.channels.clearCredentials') : t('control.channels.remove')}
          message={confirm.kind === 'clear' ? t('control.channels.confirmClear', { channel: confirm.channel }) : t('control.channels.confirmRemove', { channel: confirm.channel })}
          confirmLabel={confirm.kind === 'clear' ? t('control.channels.clearCredentials') : t('control.channels.remove')}
          busy={busy === `${confirm.kind}:${confirm.channel}`}
          onConfirm={() => void run(
            `${confirm.kind}:${confirm.channel}`,
            () => (confirm.kind === 'clear' ? channelsApi.clearCredentials(confirm.channel) : channelsApi.remove(confirm.channel, { delete: false })),
            (data) => setNotice(confirm.kind === 'clear' ? t('control.channels.cleared', { paths: ((data.cleared as string[]) ?? []).join(', ') || '—' }) : t('control.channels.removed')),
          )}
          onCancel={() => setConfirm(null)}
        />
      )}

      {capabilities && (
        <Modal title={t('control.channels.capabilitiesTitle', { channel: capabilities.channel })} onClose={() => setCapabilities(null)}>
          <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{JSON.stringify(capabilities.data, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}
