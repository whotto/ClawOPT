// 语音在浏览器里的共享状态：朗读播放器（全页只有一个，半双工：开始录音先停播放）、自动朗读开关（按浏览器记）、状态缓存。
import { useEffect, useState, useSyncExternalStore } from 'react';
import { voiceApi, type VoiceStatusView } from '../../api/voice';
import { toSpeakableText } from './voiceText';

type Listener = () => void;

// ---- 朗读播放器 ----

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let currentAbort: AbortController | null = null;
let playing = false;
const playbackListeners = new Set<Listener>();
const emitPlayback = () => playbackListeners.forEach((listener) => listener());

export function stopPlayback(): void {
  currentAbort?.abort();
  currentAbort = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
  }
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentAudio = null;
  currentUrl = null;
  if (playing) {
    playing = false;
    emitPlayback();
  }
}

/** 播放一段音频（替换正在播放的那段）。 */
export async function playAudioBlob(blob: Blob): Promise<void> {
  stopPlayback();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;
  playing = true;
  emitPlayback();
  const done = () => {
    if (currentAudio === audio) stopPlayback();
  };
  audio.onended = done;
  audio.onerror = done;
  try {
    await audio.play();
  } catch (error) {
    done();
    throw error;
  }
}

/** 合成并朗读一段回复。返回错误响应（交给调用方本地化）或 null。 */
export async function speakText(markdown: string): Promise<Response | null> {
  const text = toSpeakableText(markdown);
  if (!text) return null;
  stopPlayback();
  const controller = new AbortController();
  currentAbort = controller;
  const response = await voiceApi.synthesize(text, controller.signal);
  if (controller.signal.aborted) return null;
  currentAbort = null;
  if (!response.ok) return response;
  await playAudioBlob(await response.blob());
  return null;
}

export function usePlaybackActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      playbackListeners.add(listener);
      return () => playbackListeners.delete(listener);
    },
    () => playing,
    () => false,
  );
}

// ---- 自动朗读开关（按浏览器记；没设过时用服务端默认） ----

const AUTO_READ_KEY = 'clawopt.voice.autoRead';
const autoReadListeners = new Set<Listener>();

function readAutoReadOverride(): boolean | null {
  try {
    const value = window.localStorage.getItem(AUTO_READ_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

export function setAutoRead(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_READ_KEY, enabled ? '1' : '0');
  } catch {
    // 隐私模式写不进去：本页内照样生效。
  }
  autoReadOverride = enabled;
  if (!enabled) stopPlayback();
  autoReadListeners.forEach((listener) => listener());
}

let autoReadOverride: boolean | null = typeof window === 'undefined' ? null : readAutoReadOverride();

export function useAutoRead(serverDefault: boolean): boolean {
  const override = useSyncExternalStore(
    (listener) => {
      autoReadListeners.add(listener);
      return () => autoReadListeners.delete(listener);
    },
    () => autoReadOverride,
    () => null,
  );
  return override ?? serverDefault;
}

// ---- 状态缓存：聊天页切会话不反复拉 ----

const STATUS_TTL_MS = 60_000;
let statusCache: { at: number; promise: Promise<VoiceStatusView | null> } | null = null;

export function loadVoiceStatus(force = false): Promise<VoiceStatusView | null> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.promise;
  const promise = voiceApi.status()
    .then(async (response) => (response.ok ? (await response.json()) as VoiceStatusView : null))
    .catch(() => null);
  statusCache = { at: Date.now(), promise };
  return promise;
}

export function useVoiceStatus(): VoiceStatusView | null {
  const [status, setStatus] = useState<VoiceStatusView | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadVoiceStatus().then((value) => {
      if (!cancelled) setStatus(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

/** 浏览器有没有录音能力（MediaRecorder + getUserMedia）。 */
export function canRecordAudio(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

/** 浏览器识别（Web Speech API）；不支持返回 null。 */
export function browserSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
