// 群协作设置（P3）：交接深度、摘要模型与节奏、运行超时、远程 Agent 与访客；邀请码 / 访客名册；配对请求审批与 connector 吊销。
// 看得见群的人都能打开「远程 Agent」页签发起配对；其余页签只有管理员能改（服务端同样判）。
import { Copy, Link2, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type ConnectorView, type GuestView, type PairingView, RoomApiError, roomApi, type RoomPolicyResponse,
} from './api';

type Tab = 'policy' | 'invite' | 'relay';

export function RoomSettingsDialog({ groupId, policy, onClose, onChanged, initialTab = 'policy' }: {
  groupId: string;
  policy: RoomPolicyResponse | null;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: Tab;
}) {
  const { t } = useTranslation();
  const canManage = !!policy?.canManage;
  const [tab, setTab] = useState<Tab>(canManage ? initialTab : 'relay');
  const tabs: Tab[] = canManage ? ['policy', 'invite', 'relay'] : ['relay'];
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30" onClick={onClose} data-testid="room-settings-dialog">
      <div className="w-full sm:max-w-2xl max-h-[92vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="px-4 h-14 flex items-center gap-2 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900 flex-1">{t('rooms.settings.title')}</h2>
          <button type="button" onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
        </header>
        <nav className="px-4 pt-2 flex gap-1 border-b border-gray-100">
          {tabs.map((item) => (
            <button key={item} type="button" onClick={() => setTab(item)} className={`px-3 py-2 text-sm rounded-t-lg ${tab === item ? 'text-blue-700 border-b-2 border-blue-600 font-semibold' : 'text-gray-500 hover:text-gray-800'}`}>
              {t(`rooms.settings.tab.${item}`)}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'policy' && policy && <PolicyForm groupId={groupId} policy={policy} onChanged={onChanged} />}
          {tab === 'invite' && policy && <InviteSection groupId={groupId} policy={policy} onChanged={onChanged} />}
          {tab === 'relay' && <RelaySection groupId={groupId} policy={policy} />}
        </div>
      </div>
    </div>
  );
}

function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown) => (err instanceof RoomApiError ? String(t(err.code, { defaultValue: err.message })) : String((err as Error)?.message ?? err));
}

function PolicyForm({ groupId, policy, onChanged }: { groupId: string; policy: RoomPolicyResponse; onChanged: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const p = policy.policy;
  const [form, setForm] = useState({
    handoffEnabled: p.handoff.enabled,
    handoffUnlimited: p.handoff.unlimited,
    handoffMaxDepth: p.handoff.maxDepth,
    summaryModel: p.summaryModel,
    summaryEveryTurns: p.summaryEveryTurns,
    runIdleTimeoutSec: p.runIdleTimeoutSec,
    runTotalBudgetSec: p.runTotalBudgetSec,
    allowGuestAgents: p.allowGuestAgents,
    maxGuestAgentsPerMember: p.maxGuestAgentsPerMember,
    allowRemoteWorkspace: p.allowRemoteWorkspace,
  });
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await roomApi.updatePolicy(groupId, form);
      setStatus({ kind: 'ok', text: t('rooms.settings.saved') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const num = (value: string, fallback: number) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const field = 'w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500';
  return (
    <div className="space-y-5 text-sm">
      <section className="space-y-2">
        <h3 className="font-semibold text-gray-900">{t('rooms.settings.handoff')}</h3>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.handoffEnabled} onChange={(e) => set('handoffEnabled', e.target.checked)} />{t('rooms.settings.handoffEnabled')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!form.handoffEnabled} checked={form.handoffUnlimited} onChange={(e) => set('handoffUnlimited', e.target.checked)} />{t('rooms.settings.handoffUnlimited')}</label>
        <label className="block">
          <span className="text-xs text-gray-500">{t('rooms.settings.handoffMaxDepth')}</span>
          <input type="number" min={1} max={32} disabled={!form.handoffEnabled || form.handoffUnlimited} value={form.handoffMaxDepth} onChange={(e) => set('handoffMaxDepth', num(e.target.value, form.handoffMaxDepth))} className={field} />
        </label>
        <p className="text-xs text-gray-400">{t('rooms.settings.handoffHint')}</p>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-gray-900">{t('rooms.settings.summary')}</h3>
        <label className="block">
          <span className="text-xs text-gray-500">{t('rooms.settings.summaryModel')}</span>
          <input value={form.summaryModel} placeholder="provider:<endpoint>/<model> · agent:claude-code" onChange={(e) => set('summaryModel', e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t('rooms.settings.summaryEveryTurns')}</span>
          <input type="number" min={1} max={200} value={form.summaryEveryTurns} onChange={(e) => set('summaryEveryTurns', num(e.target.value, form.summaryEveryTurns))} className={field} />
        </label>
        <p className="text-xs text-gray-400">{t('rooms.settings.summaryHint')}</p>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-gray-900">{t('rooms.settings.timeouts')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block"><span className="text-xs text-gray-500">{t('rooms.settings.idleTimeout')}</span>
            <input type="number" min={30} value={form.runIdleTimeoutSec} onChange={(e) => set('runIdleTimeoutSec', num(e.target.value, form.runIdleTimeoutSec))} className={field} /></label>
          <label className="block"><span className="text-xs text-gray-500">{t('rooms.settings.totalBudget')}</span>
            <input type="number" min={60} value={form.runTotalBudgetSec} onChange={(e) => set('runTotalBudgetSec', num(e.target.value, form.runTotalBudgetSec))} className={field} /></label>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-gray-900">{t('rooms.settings.remote')}</h3>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.allowGuestAgents} onChange={(e) => set('allowGuestAgents', e.target.checked)} />{t('rooms.settings.allowGuestAgents')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.allowRemoteWorkspace} onChange={(e) => set('allowRemoteWorkspace', e.target.checked)} />{t('rooms.settings.allowRemoteWorkspace')}</label>
        <label className="block"><span className="text-xs text-gray-500">{t('rooms.settings.maxGuestAgents')}</span>
          <input type="number" min={0} max={10} value={form.maxGuestAgentsPerMember} onChange={(e) => set('maxGuestAgentsPerMember', num(e.target.value, form.maxGuestAgentsPerMember))} className={field} /></label>
      </section>
      <div className="flex items-center justify-end gap-3">
        {status && <span className={`text-xs ${status.kind === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{status.text}</span>}
        <button type="button" disabled={busy} onClick={save} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">{t('common.save')}</button>
      </div>
    </div>
  );
}

function InviteSection({ groupId, policy, onChanged }: { groupId: string; policy: RoomPolicyResponse; onChanged: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [guests, setGuests] = useState<GuestView[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const code = policy.policy.inviteCode;
  const link = code ? `${window.location.origin}/share/rooms/${code}` : '';
  const loadGuests = useCallback(() => { roomApi.guests(groupId).then((r) => setGuests(r.guests)).catch(() => setGuests([])); }, [groupId]);
  useEffect(loadGuests, [loadGuests, code]);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); onChanged(); loadGuests(); } catch (err) { setError(errorText(err)); }
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-gray-500">{t('rooms.invite.hint')}</p>
      {code ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
          <Link2 className="w-4 h-4 text-gray-400" />
          <code className="flex-1 min-w-0 truncate text-xs" data-testid="room-invite-link">{link}</code>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }} className="p-1.5 text-gray-500 hover:text-gray-800" title={t('common.copy')}><Copy className="w-4 h-4" /></button>
          {copied && <span className="text-[11px] text-green-600">{t('common.copied')}</span>}
        </div>
      ) : <p className="text-gray-500">{t('rooms.invite.none')}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => act(() => roomApi.createInvite(groupId))} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700">
          <RefreshCw className="w-4 h-4" />{t(code ? 'rooms.invite.rotate' : 'rooms.invite.create')}
        </button>
        {code && <button type="button" onClick={() => act(() => roomApi.revokeInvite(groupId))} className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50">{t('rooms.invite.revoke')}</button>}
      </div>
      {code && <p className="text-xs text-amber-700">{t('rooms.invite.rotateWarning')}</p>}
      <h3 className="font-semibold text-gray-900 pt-2">{t('rooms.invite.guests', { count: guests.length })}</h3>
      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        {guests.length === 0 && <li className="px-3 py-2 text-gray-400">{t('rooms.invite.noGuests')}</li>}
        {guests.map((guest) => (
          <li key={guest.id} className="px-3 py-2 flex items-center gap-2">
            <span className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center">{guest.avatar || guest.name[0]}</span>
            <span className="flex-1 truncate">{guest.name}</span>
            <button type="button" onClick={() => act(() => roomApi.revokeGuest(groupId, guest.id))} className="p-1.5 text-gray-400 hover:text-red-600" title={t('rooms.invite.revokeGuest')}><Trash2 className="w-4 h-4" /></button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function RelaySection({ groupId, policy }: { groupId: string; policy: RoomPolicyResponse | null }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [pairings, setPairings] = useState<PairingView[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    roomApi.pairings(groupId).then((r) => { setPairings(r.pairings); setCanDecide(r.canDecide); }).catch(() => setPairings([]));
    roomApi.connectors(groupId).then((r) => setConnectors(r.connectors)).catch(() => setConnectors([]));
  }, [groupId]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); load(); } catch (err) { setError(errorText(err)); }
  };
  const allowed = policy?.policy.allowGuestAgents ?? false;
  return (
    <div className="space-y-4 text-sm" data-testid="room-relay-section">
      <p className="text-xs text-gray-500">{t('rooms.relay.hint')}</p>
      {!allowed && <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-700">{t('rooms.relay.disabled')}</p>}
      <button type="button" disabled={!allowed} onClick={() => act(async () => setCode((await roomApi.createPairing(groupId)).pairingCode))} className="px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
        {t('rooms.relay.createCode')}
      </button>
      {code && (
        <div className="space-y-1">
          <p className="text-xs text-gray-500">{t('rooms.relay.codeHint')}</p>
          <div className="flex items-start gap-2">
            <textarea readOnly value={code} className="flex-1 h-20 rounded-lg border border-gray-200 p-2 font-mono text-[11px] break-all" data-testid="room-pairing-code" />
            <button type="button" onClick={() => void navigator.clipboard?.writeText(code)} className="p-2 text-gray-500 hover:text-gray-800" title={t('common.copy')}><Copy className="w-4 h-4" /></button>
          </div>
        </div>
      )}
      <h3 className="font-semibold text-gray-900">{t('rooms.relay.pending')}</h3>
      <ul className="space-y-2">
        {pairings.length === 0 && <li className="text-gray-400">{t('rooms.relay.noPending')}</li>}
        {pairings.map((pairing) => (
          <li key={pairing.requestId} className="rounded-lg border border-gray-200 px-3 py-2 flex flex-wrap items-center gap-2" data-testid="room-pairing-request">
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{pairing.descriptor?.name ?? t('rooms.relay.waitingTarget')} <span className="text-xs text-gray-400">{pairing.descriptor ? t(`externalAgent.runtimeName.${pairing.descriptor.runtime}`, { defaultValue: pairing.descriptor.runtime }) : ''}</span></p>
              <p className="text-xs text-gray-500 truncate">{t('rooms.relay.requestedBy', { name: pairing.requesterName || '—', origin: pairing.targetOrigin || '—' })} · {t(`rooms.relay.status.${pairing.status}`, { defaultValue: pairing.status })}</p>
            </div>
            {canDecide && pairing.status === 'pending' && (
              <>
                <button type="button" onClick={() => act(() => roomApi.decidePairing(groupId, pairing.requestId, true))} className="px-3 py-1.5 text-xs rounded-lg bg-green-600 text-white hover:bg-green-700">{t('rooms.relay.approve')}</button>
                <button type="button" onClick={() => act(() => roomApi.decidePairing(groupId, pairing.requestId, false))} className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50">{t('rooms.relay.reject')}</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <h3 className="font-semibold text-gray-900">{t('rooms.relay.connectors')}</h3>
      <ul className="space-y-2">
        {connectors.length === 0 && <li className="text-gray-400">{t('rooms.relay.noConnectors')}</li>}
        {connectors.map((connector) => (
          <li key={connector.id} className="rounded-lg border border-gray-200 px-3 py-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connector.status === 'revoked' ? 'bg-gray-300' : connector.online ? 'bg-green-500' : 'bg-amber-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{connector.descriptor.name}</p>
              <p className="text-xs text-gray-500 truncate">{connector.targetOrigin} · {t(connector.status === 'revoked' ? 'rooms.relay.revoked' : connector.online ? 'rooms.relay.online' : 'rooms.relay.offline')}</p>
            </div>
            {connector.status !== 'revoked' && (
              <button type="button" onClick={() => act(() => roomApi.revokeConnector(groupId, connector.id))} className="px-2 py-1 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50">{t('rooms.relay.revoke')}</button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
