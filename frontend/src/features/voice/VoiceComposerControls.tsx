// 输入区的语音按钮（P6 语音）：按住说话（松手转写，结果**追加**进输入框供编辑，从不自动发送）、自动朗读开关、停止朗读。
// 没配置语音识别、或浏览器没有录音 / 识别能力时整个按钮不出现；朗读开关只在配置了合成时出现。
import { Loader2, Mic, Square, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceRecorder, type VoiceRecorderError } from './useVoiceRecorder';
import { browserSpeechRecognition, canRecordAudio, setAutoRead, stopPlayback, useAutoRead, usePlaybackActive, useVoiceStatus } from './voiceRuntime';
import { appendTranscript } from './voiceText';

type Props = {
  input: string;
  setInput: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function VoiceComposerControls({ input, setInput, textareaRef }: Props) {
  const { t, i18n } = useTranslation();
  const status = useVoiceStatus();
  const playing = usePlaybackActive();
  const autoRead = useAutoRead(status?.autoReadDefault ?? false);
  const [error, setError] = useState<VoiceRecorderError | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  const browserMode = status?.stt.clientOnly === true;
  const recorder = useVoiceRecorder({
    mode: browserMode ? 'browser' : 'server',
    language: status?.stt.language ?? null,
    onTranscript: (text) => {
      setError(null);
      setInput(appendTranscript(inputRef.current, text));
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    onError: (next) => setError(next),
  });

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  if (!status) return null;
  const canCapture = status.stt.configured && (browserMode ? browserSpeechRecognition() !== null : canRecordAudio());
  const canSpeak = status.tts.configured;
  if (!canCapture && !canSpeak) return null;

  const phase = recorder.state.phase;
  const recording = phase === 'recording' || phase === 'requesting';
  const busy = phase === 'transcribing';
  const errorText = error ? (i18n.exists(error.code) ? t(error.code, (error.params ?? {}) as Record<string, unknown>) : t('voice.composer.failed')) : '';

  return (
    <div className="relative flex items-center gap-1">
      {errorText && (
        <div role="alert" className="absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600 z-50">
          {errorText}
        </div>
      )}
      {canCapture && (
        <button
          type="button"
          aria-label={recording ? t('voice.composer.releaseToTranscribe') : t('voice.composer.holdToTalk')}
          title={recording ? t('voice.composer.releaseToTranscribe') : t('voice.composer.holdToTalk')}
          disabled={busy}
          onPointerDown={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLButtonElement).setPointerCapture?.(event.pointerId);
            void recorder.start();
          }}
          onPointerUp={() => recorder.stop()}
          onPointerCancel={() => recorder.cancel()}
          onKeyDown={(event) => {
            if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
              event.preventDefault();
              void recorder.start();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ' || event.key === 'Enter') recorder.stop();
          }}
          className={`h-9 px-2 flex items-center justify-center gap-1 rounded-lg transition-all select-none touch-none ${recording ? 'bg-red-100 text-red-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'} disabled:opacity-60`}
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
          {recording && <span className="text-xs font-medium">{t('voice.composer.recording')}</span>}
          {busy && <span className="text-xs font-medium">{t('voice.composer.transcribing')}</span>}
        </button>
      )}
      {canSpeak && (
        <button
          type="button"
          aria-pressed={autoRead}
          title={autoRead ? t('voice.composer.autoReadOn') : t('voice.composer.autoReadOff')}
          onClick={() => setAutoRead(!autoRead)}
          className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all ${autoRead ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
        >
          {autoRead ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
        </button>
      )}
      {playing && (
        <button
          type="button"
          title={t('voice.composer.stopReading')}
          onClick={() => stopPlayback()}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-blue-600 hover:bg-blue-50 transition-all"
        >
          <Square className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default VoiceComposerControls;
