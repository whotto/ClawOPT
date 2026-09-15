// 语音设置（系统区，管理员）：当前使用的合成 / 识别服务商、各服务商的地址 / 模型 / 声音 / 密钥（只写）、内网放行、探测、试听与试录。
// 本地离线识别不随包：按主机能力闸门显示「本机不可用：原因 + 怎么开」。
import { Mic, Play, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { voiceApi, type VoiceKind, type VoiceProbeResult, type VoiceProviderOptions, type VoiceProviderView, type VoiceSettingsView } from '../../api/voice';
import { Badge, Button, Card, ErrorBanner, inputClass, labelClass, LoadingRow, NoPermissionState, Notice, PageIntro, Toggle, type ErrorDisplay } from '../../components/control/ControlUi';
import { HostFeatureNotice } from '../../components/control/HostFeatureNotice';
import { playAudioBlob, stopPlayback, usePlaybackActive } from '../../features/voice/voiceRuntime';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type Draft = { options: VoiceProviderOptions; apiKey: string };

const FIELDS: Record<VoiceKind, Record<string, Array<keyof VoiceProviderOptions>>> = {
  tts: {
    openai: ['baseUrl', 'model', 'voice', 'speed', 'format'],
    custom: ['baseUrl', 'model', 'voice', 'speed', 'format'],
    edge: ['voice', 'speed'],
    elevenlabs: ['baseUrl', 'model', 'voice', 'speed'],
    doubao: ['baseUrl', 'appId', 'cluster', 'voice', 'speed'],
  },
  stt: {
    openai: ['baseUrl', 'model', 'language'],
    custom: ['baseUrl', 'model', 'language'],
    groq: ['baseUrl', 'model', 'language'],
    elevenlabs: ['baseUrl', 'model', 'language'],
    doubao: ['baseUrl', 'appId', 'resourceId', 'language'],
    browser: ['language'],
  },
};

function ProviderEditor({ kind, providers, activeId, onSaved }: {
  kind: VoiceKind;
  providers: VoiceProviderView[];
  activeId: string | null;
  onSaved: (next: VoiceSettingsView) => void;
}) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [selected, setSelected] = useState<string>(activeId ?? providers[0]?.id ?? '');
  const provider = providers.find((entry) => entry.id === selected) ?? providers[0];
  const [draft, setDraft] = useState<Draft>({ options: {}, apiKey: '' });
  const [busy, setBusy] = useState<'save' | 'probe' | 'clear' | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<VoiceProbeResult | null>(null);

  useEffect(() => {
    if (!provider) return;
    setDraft({ options: { ...provider.options }, apiKey: '' });
    setProbe(null);
    setError(null);
    setSaved(false);
    // 只在切服务商时载入：保存后的服务端视图会经 providers 回来，那时草稿已经一致。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  if (!provider) return null;
  const fields = FIELDS[kind][provider.id] ?? [];
  const setOption = (key: keyof VoiceProviderOptions, value: unknown) => {
    setSaved(false);
    setDraft((current) => ({ ...current, options: { ...current.options, [key]: value } }));
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const result = await readApi<VoiceSettingsView>(voiceApi.saveProvider(kind, provider.id, { options: draft.options, apiKey: draft.apiKey || undefined }));
      if (result.ok) {
        onSaved(result.data);
        setDraft((current) => ({ ...current, apiKey: '' }));
        setSaved(true);
      } else setError(errors.fromResult(result, 'voice.page.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy('clear');
    try {
      const result = await readApi<VoiceSettingsView>(voiceApi.clearKey(kind, provider.id));
      if (result.ok) onSaved(result.data);
      else setError(errors.fromResult(result, 'voice.page.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const runProbe = async () => {
    setBusy('probe');
    setProbe(null);
    setError(null);
    try {
      const result = await readApi<{ result: VoiceProbeResult }>(voiceApi.probe({ kind, provider: provider.id, options: draft.options, apiKey: draft.apiKey || undefined }));
      if (result.ok) setProbe(result.data.result);
      else setError(errors.fromResult(result, 'voice.page.probeFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const placeholder = (key: keyof VoiceProviderOptions) => {
    const value = provider.defaults[key];
    return value === undefined || value === '' ? '' : String(value);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {providers.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setSelected(entry.id)}
            className={`h-8 px-3 rounded-xl border text-xs font-medium transition-all inline-flex items-center gap-1.5 ${entry.id === provider.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            {t(`voice.provider.${entry.id}`)}
            {entry.id === activeId && <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={provider.configured ? 'green' : 'gray'}>{provider.configured ? t('voice.page.configured') : t('voice.page.notConfigured')}</Badge>
        {provider.id === activeId && <Badge tone="blue">{t('voice.page.inUse')}</Badge>}
        {provider.clientOnly && <span className="text-gray-500">{t('voice.page.browserSttHint')}</span>}
      </div>

      {provider.id === 'edge' && <Notice>{t('voice.page.edgeExperimental')}</Notice>}

      <ErrorBanner error={error} onClose={() => setError(null)} />

      {fields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fields.map((key) => (
            <label key={key} className={key === 'baseUrl' ? 'md:col-span-2' : ''}>
              <span className={labelClass}>{t(`voice.field.${key}`)}</span>
              {key === 'speed' ? (
                <input type="number" min={0.5} max={2} step={0.05} className={inputClass} value={draft.options.speed ?? ''} placeholder={placeholder(key)}
                  onChange={(event) => setOption('speed', event.target.value === '' ? undefined : Number(event.target.value))} />
              ) : key === 'format' ? (
                <select className={inputClass} value={draft.options.format ?? ''} onChange={(event) => setOption('format', event.target.value || undefined)}>
                  <option value="">{t('voice.page.defaultValue', { value: placeholder(key) || 'mp3' })}</option>
                  {['mp3', 'wav', 'opus', 'aac', 'flac'].map((format) => <option key={format} value={format}>{format}</option>)}
                </select>
              ) : (
                <input className={inputClass} value={String(draft.options[key] ?? '')} placeholder={placeholder(key)} spellCheck={false}
                  onChange={(event) => setOption(key, event.target.value)} />
              )}
            </label>
          ))}
        </div>
      )}

      {provider.requiresKey || (!provider.clientOnly && provider.id !== 'edge') ? (
        <label className="block">
          <span className={labelClass}>{provider.id === 'doubao' ? t('voice.field.accessToken') : t('voice.field.apiKey')}</span>
          <div className="flex gap-2">
            <input type="password" autoComplete="new-password" className={inputClass} value={draft.apiKey}
              placeholder={provider.hasApiKey ? t('voice.page.keyStored') : (provider.requiresKey ? t('voice.page.keyRequired') : t('voice.page.keyOptional'))}
              onChange={(event) => { setSaved(false); setDraft((current) => ({ ...current, apiKey: event.target.value })); }} />
            {provider.hasApiKey && <Button variant="danger" busy={busy === 'clear'} onClick={() => void clearKey()}>{t('voice.page.clearKey')}</Button>}
          </div>
          <p className="mt-1 text-xs text-gray-500">{t('voice.page.keyWriteOnly')}</p>
        </label>
      ) : null}

      {!provider.clientOnly && provider.id !== 'edge' && (
        <div className="rounded-xl border border-gray-200 px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">{t('voice.field.allowPrivateNetwork')}</div>
              <div className="text-xs text-gray-500">{t('voice.page.allowPrivateNetworkHint')}</div>
            </div>
            <Toggle checked={draft.options.allowPrivateNetwork === true} onChange={(next) => setOption('allowPrivateNetwork', next)} label={t('voice.field.allowPrivateNetwork')} />
          </div>
          {draft.options.allowPrivateNetwork && <Notice>{t('voice.page.allowPrivateNetworkWarning')}</Notice>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>{t('common.save')}</Button>
        {!provider.clientOnly && <Button busy={busy === 'probe'} onClick={() => void runProbe()}><RefreshCw className="w-4 h-4" />{t('voice.page.probe')}</Button>}
        {saved && <span className="text-xs text-green-700">{t('voice.page.saved')}</span>}
      </div>

      {probe && (
        probe.ok ? (
          <div className="rounded-xl border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700 space-y-2">
            <div>{t('voice.page.probeOk')}</div>
            {probe.models.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {probe.models.slice(0, 12).map((model) => (
                  <button key={model} type="button" onClick={() => setOption('model', model)} className="px-2 py-0.5 rounded-full border border-green-200 bg-white text-xs font-mono text-green-800 hover:bg-green-100">{model}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <ErrorBanner error={{ message: t(probe.errorCode ?? 'voice.page.probeFailed'), detail: probe.detail ?? '' }} />
        )
      )}
    </div>
  );
}

function TestPanel({ settings }: { settings: VoiceSettingsView }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const playing = usePlaybackActive();
  const [sample, setSample] = useState('');
  const [busy, setBusy] = useState<'synth' | 'record' | 'transcribe' | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const ttsReady = Boolean(settings.config.ttsProvider && settings.tts.find((entry) => entry.id === settings.config.ttsProvider)?.configured);
  const sttProvider = settings.stt.find((entry) => entry.id === settings.config.sttProvider);
  const sttReady = Boolean(sttProvider?.configured && !sttProvider.clientOnly);

  const synth = async () => {
    setBusy('synth');
    setError(null);
    try {
      const response = await voiceApi.synthesize(sample.trim() || t('voice.page.sampleText'));
      if (!response.ok) {
        setError(errors.fromResult(await readApi(Promise.resolve(response)), 'voice.page.testFailed'));
        return;
      }
      await playAudioBlob(await response.blob());
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const record = async () => {
    setError(null);
    setTranscript(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setBusy('transcribe');
        try {
          const result = await readApi<{ text: string }>(voiceApi.transcribe(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })));
          if (result.ok) setTranscript(result.data.text);
          else setError(errors.fromResult(result, 'voice.page.testFailed'));
        } catch (exception) {
          setError(errors.fromException(exception));
        } finally {
          setBusy(null);
        }
      };
      recorderRef.current = recorder;
      stopPlayback();
      recorder.start();
      setBusy('record');
      window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 3000);
    } catch (exception) {
      setError({ message: t('voice.micDenied'), detail: exception instanceof Error ? exception.message : '' });
      setBusy(null);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <h4 className="text-base font-semibold text-gray-900">{t('voice.page.testTitle')}</h4>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="flex flex-col sm:flex-row gap-2">
        <input className={inputClass} value={sample} onChange={(event) => setSample(event.target.value)} placeholder={t('voice.page.sampleText')} />
        {playing ? (
          <Button onClick={() => stopPlayback()}><Square className="w-4 h-4" />{t('voice.composer.stopReading')}</Button>
        ) : (
          <Button disabled={!ttsReady} busy={busy === 'synth'} onClick={() => void synth()}><Play className="w-4 h-4" />{t('voice.page.testSynth')}</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!sttReady || busy === 'record'} busy={busy === 'transcribe'} onClick={() => void record()}>
          <Mic className="w-4 h-4" />{busy === 'record' ? t('voice.composer.recording') : t('voice.page.testTranscribe')}
        </Button>
        {transcript !== null && <span className="text-sm text-gray-700 break-all">{transcript || t('voice.noSpeech')}</span>}
      </div>
      {!ttsReady && !sttReady && <p className="text-xs text-gray-500">{t('voice.page.testNeedsActive')}</p>}
    </Card>
  );
}

export default function VoicePage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [settings, setSettings] = useState<VoiceSettingsView | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await readApi<VoiceSettingsView>(voiceApi.settings());
      setForbidden(result.status === 403);
      if (result.ok) setSettings(result.data);
      else if (result.status !== 403) setError(errors.fromResult(result, 'voice.page.loadFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = async (patch: Partial<VoiceSettingsView['config']>) => {
    setSavingConfig(true);
    setError(null);
    try {
      const result = await readApi<VoiceSettingsView>(voiceApi.saveConfig(patch));
      if (result.ok) setSettings(result.data);
      else setError(errors.fromResult(result, 'voice.page.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSavingConfig(false);
    }
  };

  const activeTts = settings?.config.ttsProvider ?? null;
  const activeStt = settings?.config.sttProvider ?? null;
  const warnings = useMemo(() => {
    if (!settings) return [];
    const list: string[] = [];
    if (activeTts && !settings.tts.find((entry) => entry.id === activeTts)?.configured) list.push(t('voice.page.activeNotConfigured', { provider: t(`voice.provider.${activeTts}`) }));
    if (activeStt && !settings.stt.find((entry) => entry.id === activeStt)?.configured) list.push(t('voice.page.activeNotConfigured', { provider: t(`voice.provider.${activeStt}`) }));
    return list;
  }, [settings, activeTts, activeStt, t]);

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro title={t('voice.page.title')} description={t('voice.page.description')} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {!settings ? <LoadingRow /> : (
        <>
          <Card className="p-5 space-y-4">
            <h4 className="text-base font-semibold text-gray-900">{t('voice.page.activeTitle')}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label>
                <span className={labelClass}>{t('voice.page.ttsProvider')}</span>
                <select className={inputClass} value={activeTts ?? ''} disabled={savingConfig} onChange={(event) => void saveConfig({ ttsProvider: event.target.value || null })}>
                  <option value="">{t('voice.page.disabled')}</option>
                  {settings.tts.map((entry) => <option key={entry.id} value={entry.id}>{t(`voice.provider.${entry.id}`)}</option>)}
                </select>
              </label>
              <label>
                <span className={labelClass}>{t('voice.page.sttProvider')}</span>
                <select className={inputClass} value={activeStt ?? ''} disabled={savingConfig} onChange={(event) => void saveConfig({ sttProvider: event.target.value || null })}>
                  <option value="">{t('voice.page.disabled')}</option>
                  {settings.stt.map((entry) => <option key={entry.id} value={entry.id}>{t(`voice.provider.${entry.id}`)}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{t('voice.page.autoReadDefault')}</div>
                <div className="text-xs text-gray-500">{t('voice.page.autoReadDefaultHint')}</div>
              </div>
              <Toggle checked={settings.config.autoReadDefault} disabled={savingConfig} onChange={(next) => void saveConfig({ autoReadDefault: next })} label={t('voice.page.autoReadDefault')} />
            </div>
            {warnings.map((warning) => <Notice key={warning}>{warning}</Notice>)}
            <p className="text-xs text-gray-500">{t('voice.page.halfDuplexHint')}</p>
          </Card>

          <Card className="p-5 space-y-4">
            <h4 className="text-base font-semibold text-gray-900">{t('voice.page.ttsTitle')}</h4>
            <ProviderEditor kind="tts" providers={settings.tts} activeId={activeTts} onSaved={setSettings} />
          </Card>

          <Card className="p-5 space-y-4">
            <h4 className="text-base font-semibold text-gray-900">{t('voice.page.sttTitle')}</h4>
            <ProviderEditor kind="stt" providers={settings.stt} activeId={activeStt} onSaved={setSettings} />
          </Card>

          <TestPanel settings={settings} />

          <div className="space-y-2">
            <h4 className="text-base font-semibold text-gray-900">{t('voice.page.localSttTitle')}</h4>
            {settings.localStt.available
              ? <Notice tone="green">{t('voice.page.localSttAvailable')}</Notice>
              : <HostFeatureNotice reasonCode={settings.localStt.reasonCode} />}
          </div>
        </>
      )}
    </div>
  );
}
