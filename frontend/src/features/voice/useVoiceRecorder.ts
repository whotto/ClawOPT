// 半双工按住说话：按下开始录音（先停掉正在播放的朗读）、松手结束并转写，结果交给 onTranscript（追加进输入框，不发送）。
// 服务端识别走 MediaRecorder → POST /api/voice/transcribe；选了浏览器识别时用 Web Speech API，音频不出浏览器。
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { voiceApi } from '../../api/voice';
import { browserSpeechRecognition, stopPlayback } from './voiceRuntime';
import { MIN_RECORDING_MS, recorderReducer, type RecorderState } from './voiceText';

export type VoiceRecorderError = { code: string; detail?: string; params?: Record<string, unknown> | null };

const PREFERRED_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return PREFERRED_MIME.find((type) => MediaRecorder.isTypeSupported(type));
}

export function useVoiceRecorder(options: {
  mode: 'server' | 'browser';
  language?: string | null;
  onTranscript: (text: string) => void;
  onError: (error: VoiceRecorderError) => void;
}) {
  const [state, dispatchState] = useReducer(recorderReducer, { phase: 'idle' } as RecorderState);
  // 回调里要读「此刻」的状态（授权框期间松手、识别结束时的阶段）：引用同步推进，不等下一次渲染。
  const stateRef = useRef<RecorderState>(state);
  const dispatch = useCallback((event: Parameters<typeof recorderReducer>[1]) => {
    stateRef.current = recorderReducer(stateRef.current, event);
    dispatchState(event);
  }, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const recognitionRef = useRef<InstanceType<NonNullable<ReturnType<typeof browserSpeechRecognition>>> | null>(null);
  const transcriptRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const fail = useCallback((code: string, detail?: string, params?: Record<string, unknown> | null) => {
    releaseStream();
    dispatch({ type: 'fail', code });
    optionsRef.current.onError({ code, detail, params });
  }, [dispatch, releaseStream]);

  const start = useCallback(async () => {
    if (stateRef.current.phase !== 'idle' && stateRef.current.phase !== 'error') return;
    // 半双工：开口说话先停掉正在念的回复（打断朗读，不打断 Agent 的运行）。
    stopPlayback();
    dispatch({ type: 'press' });

    if (optionsRef.current.mode === 'browser') {
      const Recognition = browserSpeechRecognition();
      if (!Recognition) {
        fail('voice.browserSttUnsupported');
        return;
      }
      const recognition = new Recognition();
      recognition.lang = optionsRef.current.language || navigator.language || 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = false;
      transcriptRef.current = '';
      recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) transcriptRef.current += result[0]?.transcript ?? '';
        }
      };
      recognition.onerror = (event) => {
        if (event.error === 'aborted' || event.error === 'no-speech') return;
        fail(event.error === 'not-allowed' ? 'voice.micDenied' : 'voice.browserSttFailed', event.error);
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        if (stateRef.current.phase === 'transcribing' || stateRef.current.phase === 'recording') {
          const text = transcriptRef.current.trim();
          dispatch({ type: 'transcribed' });
          if (text) optionsRef.current.onTranscript(text);
          else optionsRef.current.onError({ code: 'voice.noSpeech' });
        }
      };
      recognitionRef.current = recognition;
      try {
        recognition.start();
        dispatch({ type: 'granted', at: Date.now() });
        startedAtRef.current = Date.now();
      } catch (error) {
        fail('voice.browserSttFailed', error instanceof Error ? error.message : '');
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 授权框弹出期间已经松手：直接收掉，不录。
      if (!isPhase(stateRef.current, 'requesting')) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        const duration = Date.now() - startedAtRef.current;
        releaseStream();
        if (duration < MIN_RECORDING_MS || blob.size === 0) {
          dispatch({ type: 'cancel' });
          optionsRef.current.onError({ code: 'voice.recordingTooShort' });
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        voiceApi.transcribe(blob, optionsRef.current.language, controller.signal)
          .then(async (response) => {
            const body = await response.json().catch(() => ({}));
            if (controller.signal.aborted) return;
            if (!response.ok || body?.success === false) {
              fail(body?.errorCode || 'voice.transcribeFailed', body?.errorDetail || '', body?.errorParams ?? null);
              return;
            }
            dispatch({ type: 'transcribed' });
            if (typeof body.text === 'string' && body.text.trim()) optionsRef.current.onTranscript(body.text);
          })
          .catch((error) => {
            if (!controller.signal.aborted) fail('voice.transcribeFailed', error instanceof Error ? error.message : '');
          });
      };
      recorderRef.current = recorder;
      recorder.start();
      startedAtRef.current = Date.now();
      dispatch({ type: 'granted', at: startedAtRef.current });
    } catch (error) {
      const name = (error as DOMException)?.name;
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'voice.micDenied' : 'voice.micUnavailable', (error as Error)?.message);
    }
  }, [dispatch, fail, releaseStream]);

  const stop = useCallback(() => {
    const phase = stateRef.current.phase;
    if (phase !== 'recording' && phase !== 'requesting') return;
    dispatch({ type: 'release' });
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  }, [dispatch]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    recognitionRef.current?.abort();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    releaseStream();
    dispatch({ type: 'cancel' });
  }, [dispatch, releaseStream]);

  useEffect(() => () => {
    abortRef.current?.abort();
    recognitionRef.current?.abort();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  return { state, start, stop, cancel };
}

/** 读引用里的阶段（绕开 TS 对前面判断的收窄：await 之后状态可能已经变了）。 */
function isPhase(state: RecorderState, phase: RecorderState['phase']): boolean {
  return state.phase === phase;
}
