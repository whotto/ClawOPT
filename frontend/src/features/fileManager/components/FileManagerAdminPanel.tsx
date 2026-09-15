// super_admin：额外根、远端连接（SSH / Docker）、SSH 主机密钥。主机密钥只能「扫描 → 核对指纹 → 确认」进来，没有关掉校验的开关。
import { KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileManagerApi } from '../../../api/fileManager';
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, Notice, type ErrorDisplay } from '../../../components/control/ControlUi';
import { HostFeatureNotice } from '../../../components/control/HostFeatureNotice';
import { readApi, useErrorDisplay } from '../../../pages/control/useControlApi';

type Gate = { allowed: boolean; reason: string | null };
type Connection = { id: string; kind: 'ssh' | 'docker'; name: string; host: string | null; port: number | null; user: string | null; container: string | null; rootPath: string; hasKey: boolean; available: boolean; reasonCode: string | null };
type KnownHost = { hostPattern: string; keyType: string; fingerprint: string };
type Config = { extraRoots: Array<{ id: string; name: string; path: string }>; connections: Connection[]; gates: { ssh: Gate; docker: Gate }; knownHosts: KnownHost[] };
type Scan = { scanId: string; hostPattern: string; keys: KnownHost[]; alreadyKnown: string[] };

const EMPTY_CONNECTION = { kind: 'ssh' as 'ssh' | 'docker', name: '', host: '', port: '22', user: '', keyPath: '', container: '', rootPath: '' };

export function FileManagerAdminPanel({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [rootForm, setRootForm] = useState({ name: '', path: '' });
  const [connectionForm, setConnectionForm] = useState<typeof EMPTY_CONNECTION | null>(null);
  const [scanForm, setScanForm] = useState({ host: '', port: '22' });
  const [scan, setScan] = useState<Scan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    const result = await readApi<Config>(fileManagerApi.config()).catch(() => null);
    if (result?.ok) setConfig(result.data);
    else if (result) setError(errors.fromResult(result, 'fileManager.page.loadFailed'));
  }, [errors]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, request: () => Promise<Response>, after?: (data: any) => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi<any>(request());
      if (!result.ok) {
        setError(errors.fromResult(result, 'fileManager.page.actionFailed'));
        return false;
      }
      after?.(result.data);
      await load();
      onChanged();
      return true;
    } catch (exception) {
      setError(errors.fromException(exception));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!config) return error ? <ErrorBanner error={error} onClose={() => setError(null)} /> : <LoadingRow />;

  const saveConnection = async () => {
    if (!connectionForm) return;
    const body = connectionForm.kind === 'ssh'
      ? { kind: 'ssh', name: connectionForm.name, host: connectionForm.host, port: Number(connectionForm.port) || 22, user: connectionForm.user, rootPath: connectionForm.rootPath, ...(connectionForm.keyPath.trim() ? { keyPath: connectionForm.keyPath.trim() } : {}) }
      : { kind: 'docker', name: connectionForm.name, container: connectionForm.container, rootPath: connectionForm.rootPath };
    if (await act('connection', () => fileManagerApi.createConnection(body))) setConnectionForm(null);
  };

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <Card className="p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">{t('fileManager.admin.extraRootsTitle')}</h4>
          <p className="text-xs text-gray-500 mt-1">{t('fileManager.admin.extraRootsHelp')}</p>
        </div>
        {config.extraRoots.map((root) => (
          <div key={root.id} className="flex items-center gap-2 text-sm">
            <span className="font-medium truncate">{root.name}</span>
            <span className="font-mono text-xs text-gray-400 truncate flex-1 min-w-0">{root.path}</span>
            <Button size="sm" variant="danger" onClick={() => setConfirm({ title: t('fileManager.admin.removeRoot'), message: root.path, run: async () => { await act(`root-${root.id}`, () => fileManagerApi.removeExtraRoot(root.id)); } })}><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        ))}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
          <input className={inputClass} placeholder={t('fileManager.admin.rootName')} value={rootForm.name} onChange={(event) => setRootForm({ ...rootForm, name: event.target.value })} />
          <input className={`${inputClass} font-mono`} placeholder={t('fileManager.admin.rootPathPlaceholder')} value={rootForm.path} onChange={(event) => setRootForm({ ...rootForm, path: event.target.value })} />
          <Button variant="primary" busy={busy === 'root'} disabled={!rootForm.path.trim()} onClick={async () => { if (await act('root', () => fileManagerApi.addExtraRoot(rootForm))) setRootForm({ name: '', path: '' }); }}><Plus className="w-4 h-4" />{t('fileManager.admin.addRoot')}</Button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">{t('fileManager.admin.connectionsTitle')}</h4>
            <p className="text-xs text-gray-500 mt-1">{t('fileManager.admin.connectionsHelp')}</p>
          </div>
          <Button size="sm" onClick={() => setConnectionForm({ ...EMPTY_CONNECTION })}><Plus className="w-3.5 h-3.5" />{t('fileManager.admin.addConnection')}</Button>
        </div>
        {!config.gates.ssh.allowed && <HostFeatureNotice reasonCode={config.gates.ssh.reason} />}
        {!config.gates.docker.allowed && <HostFeatureNotice reasonCode={config.gates.docker.reason} />}
        {config.connections.map((connection) => (
          <div key={connection.id} className="rounded-xl border border-gray-200 px-3 py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={connection.kind === 'ssh' ? 'blue' : 'gray'}>{connection.kind.toUpperCase()}</Badge>
              <span className="font-medium">{connection.name}</span>
              <span className="font-mono text-xs text-gray-500 truncate min-w-0">
                {connection.kind === 'ssh' ? `${connection.user}@${connection.host}:${connection.port}` : connection.container}:{connection.rootPath}
              </span>
              {connection.hasKey && <span title={t('fileManager.admin.hasKey')}><KeyRound className="w-3.5 h-3.5 text-gray-400" /></span>}
              {!connection.available && <Badge tone="amber">{t('hostFeature.unavailableTitle')}</Badge>}
              <div className="flex-1" />
              <Button size="sm" busy={busy === `test-${connection.id}`} onClick={() => void act(`test-${connection.id}`, () => fileManagerApi.testConnection(connection.id), (data) => setTestResult((current) => ({ ...current, [connection.id]: { ok: data.result.ok, message: data.result.ok ? t('fileManager.admin.testOk', { count: data.result.entries }) : `${t(data.result.errorCode)}${data.result.errorDetail ? ` — ${data.result.errorDetail}` : ''}` } })))}><Wifi className="w-3.5 h-3.5" />{t('fileManager.admin.test')}</Button>
              <Button size="sm" variant="danger" onClick={() => setConfirm({ title: t('fileManager.admin.removeConnection'), message: connection.name, run: async () => { await act(`conn-${connection.id}`, () => fileManagerApi.removeConnection(connection.id)); } })}><Trash2 className="w-3.5 h-3.5" /></Button>
            </div>
            {testResult[connection.id] && <div className={`text-xs ${testResult[connection.id].ok ? 'text-green-600' : 'text-red-600'} break-all`}>{testResult[connection.id].message}</div>}
          </div>
        ))}
      </Card>

      <Card className="p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-gray-500" />{t('fileManager.admin.knownHostsTitle')}</h4>
          <p className="text-xs text-gray-500 mt-1">{t('fileManager.admin.knownHostsHelp')}</p>
        </div>
        {config.knownHosts.length === 0 ? <div className="text-xs text-gray-400">{t('fileManager.admin.knownHostsEmpty')}</div> : config.knownHosts.map((key) => (
          <div key={`${key.hostPattern}-${key.fingerprint}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">{key.hostPattern}</span>
            <Badge>{key.keyType}</Badge>
            <span className="font-mono text-gray-500 break-all flex-1 min-w-0">{key.fingerprint}</span>
            <Button size="sm" variant="danger" onClick={() => setConfirm({ title: t('fileManager.admin.removeHostKey'), message: `${key.hostPattern}\n${key.fingerprint}`, run: async () => { await act('kh-remove', () => fileManagerApi.removeHostKey(key.hostPattern, key.fingerprint)); } })}><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        ))}
        <div className="grid grid-cols-[1fr_6rem_auto] gap-2">
          <input className={`${inputClass} font-mono`} placeholder={t('fileManager.admin.host')} value={scanForm.host} onChange={(event) => setScanForm({ ...scanForm, host: event.target.value })} />
          <input className={inputClass} inputMode="numeric" value={scanForm.port} onChange={(event) => setScanForm({ ...scanForm, port: event.target.value })} />
          <Button busy={busy === 'scan'} disabled={!scanForm.host.trim() || !config.gates.ssh.allowed} onClick={() => void act('scan', () => fileManagerApi.scanHostKeys(scanForm.host.trim(), Number(scanForm.port) || 22), (data) => { setScan(data.scan); setChosen(new Set()); })}><RefreshCw className="w-4 h-4" />{t('fileManager.admin.scan')}</Button>
        </div>
      </Card>

      {scan && (
        <Modal
          title={t('fileManager.admin.verifyTitle', { host: scan.hostPattern })}
          onClose={() => setScan(null)}
          footer={(
            <>
              <Button onClick={() => setScan(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy === 'trust'} disabled={chosen.size === 0} onClick={async () => { if (await act('trust', () => fileManagerApi.trustHostKeys(scan.scanId, [...chosen]))) setScan(null); }}>{t('fileManager.admin.trust')}</Button>
            </>
          )}
        >
          <Notice>{t('fileManager.admin.verifyHelp')}</Notice>
          {scan.keys.map((key) => (
            <label key={key.fingerprint} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={chosen.has(key.fingerprint)} onChange={(event) => setChosen((current) => { const next = new Set(current); if (event.target.checked) next.add(key.fingerprint); else next.delete(key.fingerprint); return next; })} />
              <span className="min-w-0">
                <Badge>{key.keyType}</Badge>
                <span className="block font-mono text-xs break-all mt-1">{key.fingerprint}</span>
                {scan.alreadyKnown.includes(key.fingerprint) && <span className="text-xs text-green-600">{t('fileManager.admin.alreadyTrusted')}</span>}
              </span>
            </label>
          ))}
        </Modal>
      )}

      {connectionForm && (
        <Modal
          title={t('fileManager.admin.addConnection')}
          onClose={() => setConnectionForm(null)}
          footer={(
            <>
              <Button onClick={() => setConnectionForm(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy === 'connection'} onClick={() => void saveConnection()}>{t('common.save')}</Button>
            </>
          )}
        >
          <div className="grid grid-cols-2 gap-2">
            {(['ssh', 'docker'] as const).map((kind) => (
              <Button key={kind} variant={connectionForm.kind === kind ? 'primary' : 'secondary'} onClick={() => setConnectionForm({ ...connectionForm, kind })}>{kind.toUpperCase()}</Button>
            ))}
          </div>
          <Field label={t('fileManager.admin.connectionName')} value={connectionForm.name} onChange={(name) => setConnectionForm({ ...connectionForm, name })} />
          {connectionForm.kind === 'ssh' ? (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label={t('fileManager.admin.host')} mono value={connectionForm.host} onChange={(host) => setConnectionForm({ ...connectionForm, host })} />
                <Field label={t('fileManager.admin.port')} value={connectionForm.port} onChange={(port) => setConnectionForm({ ...connectionForm, port })} />
              </div>
              <Field label={t('fileManager.admin.user')} mono value={connectionForm.user} onChange={(user) => setConnectionForm({ ...connectionForm, user })} />
              <Field label={t('fileManager.admin.keyPath')} mono placeholder={t('fileManager.admin.keyPathPlaceholder')} value={connectionForm.keyPath} onChange={(keyPath) => setConnectionForm({ ...connectionForm, keyPath })} />
              <p className="text-xs text-gray-500">{t('fileManager.admin.hostKeyNote')}</p>
            </>
          ) : (
            <Field label={t('fileManager.admin.container')} mono value={connectionForm.container} onChange={(container) => setConnectionForm({ ...connectionForm, container })} />
          )}
          <Field label={t('fileManager.admin.remoteRoot')} mono placeholder="/srv/app" value={connectionForm.rootPath} onChange={(rootPath) => setConnectionForm({ ...connectionForm, rootPath })} />
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={t('fileManager.actions.delete')}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { const run = confirm.run; setConfirm(null); await run(); }}
        />
      )}
    </div>
  );
}

function Field({ label, value, onChange, mono, placeholder }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean; placeholder?: string }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input className={`${inputClass}${mono ? ' font-mono' : ''}`} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
