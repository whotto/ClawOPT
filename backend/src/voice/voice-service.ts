/**
 * 语音（P6，spec 07 §2.15–§2.19）：TTS / STT 服务商适配层、密钥只写不读、探测过出站策略、本地离线识别按主机能力说明。
 *
 * 骨架：实现由 P6 语音分支补齐。
 */
import type { DB } from '../core/db';
import type { HostCapabilities } from '../runtime';

export type VoiceServiceDeps = {
  db: DB;
  /** 密钥封存用的数据目录（本机密钥文件 0600）。 */
  dataDir: string;
  hostCapabilities: () => Promise<HostCapabilities>;
};

export function createVoiceService(_deps: VoiceServiceDeps) {
  return {
    status(): { tts: { configured: boolean }; stt: { configured: boolean } } {
      return { tts: { configured: false }, stt: { configured: false } };
    },
  };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
