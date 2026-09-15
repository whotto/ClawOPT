// 出站 Webhook：端点列表（投递统计、最近状态）、增改（密钥只写不读）、测试发送、投递记录、本机回环测试收件箱。
import { Inbox, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clearWebhookLocalTestEvents,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookLocalTestTarget,
  listWebhookDeliveries,
  listWebhookEndpoints,
  listWebhookEventTypes,
  listWebhookLocalTestEvents,
  testWebhookEndpoint,
  updateWebhookEndpoint,
} from '../../../api/automationKanban';
import { ErrorBanner, Field, InfoBanner, Modal, StatusBadge, Toggle, formatTime, iconButton, inputClass, primaryButton, secondaryButton } from '../../../features/workflow/components/ui';
import { describeError, requestJson, type ApiError } from '../../../features/workflow/lib/request';

type Endpoint = {
  id: string; name: string; url: string; hasSecret: boolean; eventTypes: string[]; enabled: boolean; includeContent: boolean; allowPrivateNetwork: boolean; maxRetries: number;
  stats: { pending: number; delivered: number; failed: number; dropped: number; last: { status: string; lastStatus: number | null; lastError: string | null; finishedAt: number | null } | null };
};
type Delivery = { id: number; eventType: string; eventId: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: number; finishedAt: number | null };
type TestEvent = { receivedAt: number; eventType: string; eventId: string; signatureValid: boolean | null };
type Draft = { id: string | null; name: string; url: string; secret: string; clearSecret: boolean; hasSecret: boolean; eventTypes: string[]; enabled: boolean; includeContent: boolean; allowPrivateNetwork: boolean; maxRetries: string };

const emptyDraft = (): Draft => ({ id: null, name: '', url: '', secret: '', clearSecret: false, hasSecret: false, eventTypes: ['workflow.run.completed', 'workflow.run.failed'], enabled: true, includeContent: false, allowPrivateNetwork: false, maxRetries: '3' });

export default function WebhooksPage() {
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [deliveries, setDeliveries] = useState<{ id: string; rows: Delivery[] } | null>(null);
  const [inbox, setInbox] = useState<TestEvent[]>([]);

  const reload = useCallback(async () => {
    const [list, inboxResult] = await Promise.all([
      requestJson<{ endpoints: Endpoint[] }>(listWebhookEndpoints()),
      requestJson<{ events: TestEvent[] }>(listWebhookLocalTestEvents()),
    ]);
    if (list.ok) setEndpoints(list.data.endpoints);
    if (inboxResult.ok) setInbox(inboxResult.data.events);
  }, []);

  useEffect(() => {
    void reload();
    void requestJson<{ eventTypes: string[] }>(listWebhookEventTypes()).then((result) => result.ok && setEventTypes(result.data.eventTypes));
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const save = async () => {
    if (!draft) return;
    const body = {
      name: draft.name, url: draft.url, event_types: draft.eventTypes, enabled: draft.enabled, include_content: draft.includeContent,
      allow_private_network: draft.allowPrivateNetwork, max_retries: Number(draft.maxRetries),
      ...(draft.secret ? { secret: draft.secret } : {}), ...(draft.clearSecret ? { clear_secret: true } : {}),
    };
    const result = await requestJson(draft.id ? updateWebhookEndpoint(draft.id, body) : createWebhookEndpoint(body));
    if (!result.ok) return setError(result.error);
    setError(null);
    setDraft(null);
    void reload();
  };

  const prefillLocalTarget = async () => {
    const result = await requestJson<{ url: string; allowPrivateNetwork: boolean }>(getWebhookLocalTestTarget());
    if (result.ok) setDraft({ ...emptyDraft(), name: t('automation.webhooks.localTestName'), url: result.data.url, allowPrivateNetwork: true, secret: crypto.randomUUID().replace(/-/g, '') });
  };

  const test = async (endpoint: Endpoint) => {
    const result = await requestJson<{ outcome: { status: number; error: string | null; durationMs: number } }>(testWebhookEndpoint(endpoint.id));
    if (result.ok) setTestResult({ id: endpoint.id, ok: true, text: t('automation.webhooks.testOk', { status: result.data.outcome.status, ms: result.data.outcome.durationMs }) });
    else setTestResult({ id: endpoint.id, ok: false, text: result.error.detail ?? describeError(t, result.error) });
    void reload();
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('automation.webhooks.title')}</h3>
            <p className="text-sm text-gray-500">{t('automation.webhooks.description')}</p>
          </div>
          <button className={primaryButton} onClick={() => setDraft(emptyDraft())}><Plus className="w-4 h-4" />{t('automation.webhooks.add')}</button>
        </div>
        {error && !draft && <ErrorBanner message={describeError(t, error)} detail={error.detail} onDismiss={() => setError(null)} />}
        <div className="space-y-3">
          {endpoints.length === 0 && <div className="bg-white p-6 rounded-2xl border border-gray-200 text-sm text-gray-500">{t('automation.webhooks.empty')}</div>}
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} className="bg-white p-4 rounded-2xl border border-gray-200 space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-900">{endpoint.name}</span>
                {!endpoint.enabled && <StatusBadge status="canceled" label={t('automation.webhooks.disabled')} />}
                {endpoint.stats.last && <StatusBadge status={endpoint.stats.last.status === 'delivered' ? 'completed' : endpoint.stats.last.status === 'failed' ? 'failed' : 'running'} label={t(`automation.webhooks.deliveryStatus.${endpoint.stats.last.status}`)} />}
                <button className={iconButton} title={t('automation.webhooks.test')} onClick={() => void test(endpoint)}><Send className="w-4 h-4" /></button>
                <button className={iconButton} title={t('common.edit')} onClick={() => setDraft({ id: endpoint.id, name: endpoint.name, url: endpoint.url, secret: '', clearSecret: false, hasSecret: endpoint.hasSecret, eventTypes: endpoint.eventTypes, enabled: endpoint.enabled, includeContent: endpoint.includeContent, allowPrivateNetwork: endpoint.allowPrivateNetwork, maxRetries: String(endpoint.maxRetries) })}><Pencil className="w-4 h-4" /></button>
                <button className={iconButton} title={t('common.delete')} onClick={async () => { await requestJson(deleteWebhookEndpoint(endpoint.id)); void reload(); }}><Trash2 className="w-4 h-4" /></button>
              </div>
              <code className="block text-xs text-gray-600 font-mono break-all">{endpoint.url}</code>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>{t('automation.webhooks.stats', endpoint.stats)}</span>
                <span>{endpoint.hasSecret ? t('automation.webhooks.signed') : t('automation.webhooks.unsigned')}</span>
                <button className="text-blue-600" onClick={async () => {
                  if (deliveries?.id === endpoint.id) return setDeliveries(null);
                  const result = await requestJson<{ deliveries: Delivery[] }>(listWebhookDeliveries(endpoint.id));
                  if (result.ok) setDeliveries({ id: endpoint.id, rows: result.data.deliveries });
                }}>{t('automation.webhooks.deliveries')}</button>
              </div>
              {endpoint.stats.last?.lastError && <div className="text-xs text-red-600 break-words">{endpoint.stats.last.lastError}</div>}
              {testResult?.id === endpoint.id && <div className={`text-xs ${testResult.ok ? 'text-green-700' : 'text-red-600'} break-words`}>{testResult.text}</div>}
              {deliveries?.id === endpoint.id && (
                <ul className="border-t border-gray-100 pt-2 space-y-1 text-xs text-gray-600">
                  {deliveries.rows.length === 0 && <li className="text-gray-400">{t('automation.webhooks.noDeliveries')}</li>}
                  {deliveries.rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap gap-2">
                      <span className="font-mono">{row.eventType}</span>
                      <span>{t(`automation.webhooks.deliveryStatus.${row.status}`)}</span>
                      <span className="text-gray-400">{t('automation.webhooks.attempts', { count: row.attempts })}{row.lastStatus ? ` · HTTP ${row.lastStatus}` : ''}</span>
                      <span className="text-gray-400">{formatTime(row.finishedAt ?? row.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        <div className="bg-white p-4 rounded-2xl border border-gray-200 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Inbox className="w-4 h-4 text-gray-500" />
            <h4 className="flex-1 text-sm font-semibold text-gray-900">{t('automation.webhooks.inboxTitle')}</h4>
            <button className={secondaryButton} onClick={() => void prefillLocalTarget()}>{t('automation.webhooks.prefillLocalTarget')}</button>
            <button className={secondaryButton} onClick={async () => { await requestJson(clearWebhookLocalTestEvents()); void reload(); }}>{t('common.clear')}</button>
          </div>
          <p className="text-xs text-gray-500">{t('automation.webhooks.inboxHint')}</p>
          {inbox.length === 0 && <p className="text-xs text-gray-400">{t('automation.webhooks.inboxEmpty')}</p>}
          <ul className="space-y-1 text-xs text-gray-600">
            {inbox.map((event) => (
              <li key={`${event.eventId}:${event.receivedAt}`} className="flex flex-wrap gap-2">
                <span className="text-gray-400">{formatTime(event.receivedAt)}</span>
                <span className="font-mono">{event.eventType}</span>
                <span className={event.signatureValid === false ? 'text-red-600' : event.signatureValid ? 'text-green-700' : 'text-gray-400'}>
                  {t(`automation.webhooks.signature.${event.signatureValid === null ? 'none' : event.signatureValid ? 'valid' : 'invalid'}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {draft && (
        <Modal title={draft.id ? t('automation.webhooks.edit') : t('automation.webhooks.add')} onClose={() => { setDraft(null); setError(null); }} footer={(
          <>
            <button className={secondaryButton} onClick={() => { setDraft(null); setError(null); }}>{t('common.cancel')}</button>
            <button className={primaryButton} disabled={!draft.name.trim() || !draft.url.trim() || !draft.eventTypes.length} onClick={() => void save()}>{t('common.save')}</button>
          </>
        )}>
          {error && <ErrorBanner message={describeError(t, error)} detail={error.detail} onDismiss={() => setError(null)} />}
          <Field label={t('automation.webhooks.fields.name')} required><input className={inputClass} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label={t('automation.webhooks.fields.url')} required hint={t('automation.webhooks.fields.urlHint')}><input className={`${inputClass} font-mono`} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></Field>
          <Field label={t('automation.webhooks.fields.secret')} hint={draft.hasSecret ? t('automation.webhooks.fields.secretKeep') : t('automation.webhooks.fields.secretHint')}>
            <input className={`${inputClass} font-mono`} type="password" autoComplete="new-password" value={draft.secret} placeholder={draft.hasSecret ? '••••••••' : ''} onChange={(event) => setDraft({ ...draft, secret: event.target.value, clearSecret: false })} />
          </Field>
          {draft.hasSecret && <Toggle checked={draft.clearSecret} onChange={(clearSecret) => setDraft({ ...draft, clearSecret, secret: '' })} label={t('automation.webhooks.fields.clearSecret')} />}
          <Field label={t('automation.webhooks.fields.events')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {eventTypes.map((type) => (
                <label key={type} className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={draft.eventTypes.includes(type)} onChange={(event) => setDraft({ ...draft, eventTypes: event.target.checked ? [...draft.eventTypes, type] : draft.eventTypes.filter((item) => item !== type) })} />
                  <span>{t(`automation.webhooks.eventTypes.${type.replace(/\./g, '_')}`)}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('automation.webhooks.fields.maxRetries')}><input className={inputClass} type="number" min={0} max={10} value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: event.target.value })} /></Field>
          <div className="space-y-2">
            <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t('automation.webhooks.fields.enabled')} />
            <Toggle checked={draft.includeContent} onChange={(includeContent) => setDraft({ ...draft, includeContent })} label={t('automation.webhooks.fields.includeContent')} />
            <Toggle checked={draft.allowPrivateNetwork} onChange={(allowPrivateNetwork) => setDraft({ ...draft, allowPrivateNetwork })} label={t('automation.webhooks.fields.allowPrivate')} />
          </div>
          {draft.allowPrivateNetwork && <InfoBanner>{t('automation.webhooks.fields.allowPrivateWarning')}</InfoBanner>}
        </Modal>
      )}
    </div>
  );
}
