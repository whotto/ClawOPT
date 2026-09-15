/**
 * 语音设置的存储：SQLite 两张表（只加表，`IF NOT EXISTS`）。
 *
 * - `voice_providers`：每个 (种类, 服务商) 一行，非密钥选项 JSON + **封存后的** key；
 * - `voice_config`：当前选中的 TTS / STT 服务商、默认自动朗读。
 *
 * key 只进不出：封存用运行时平面同一个 `LocalSecretBox`（AES-256-GCM，本机密钥文件 0600 在 `<数据目录>/voice/`），
 * AAD 绑定 (种类, 服务商)——行被挪到别的服务商下解不开。读接口只报 `hasApiKey`。
 */
import type Database from 'better-sqlite3';
import path from 'path';

import { LocalSecretBox } from '../runtime';
import { STT_PROVIDER_IDS, TTS_PROVIDER_IDS, type VoiceKind, type VoiceProviderOptions } from './providers';

type ProviderRow = { kind: string; provider: string; options: string; sealed_key: string | null; updated_at: number };

const OPTION_KEYS: ReadonlyArray<keyof VoiceProviderOptions> = ['baseUrl', 'model', 'voice', 'speed', 'format', 'language', 'appId', 'cluster', 'resourceId', 'allowPrivateNetwork'];

export type VoiceConfig = { ttsProvider: string | null; sttProvider: string | null; autoReadDefault: boolean };

export function sanitizeProviderOptions(raw: unknown): VoiceProviderOptions {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: VoiceProviderOptions = {};
  for (const key of OPTION_KEYS) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'speed') {
      const speed = Number(value);
      if (Number.isFinite(speed)) out.speed = Math.min(2, Math.max(0.5, speed));
    } else if (key === 'allowPrivateNetwork') {
      out.allowPrivateNetwork = value === true;
    } else if (typeof value === 'string') {
      const text = value.trim().slice(0, key === 'baseUrl' ? 500 : 200);
      if (text && !/[\r\n\0]/.test(text)) (out as Record<string, unknown>)[key] = text;
    }
  }
  return out;
}

export function createVoiceSettingsStore(options: { sql: Database.Database; dataDir: string; now?: () => number }) {
  const { sql } = options;
  const now = options.now ?? Date.now;
  const box = new LocalSecretBox(path.join(options.dataDir, 'voice', 'secret.key'));
  sql.exec(`
    CREATE TABLE IF NOT EXISTS voice_providers (
      kind TEXT NOT NULL CHECK (kind IN ('tts', 'stt')),
      provider TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}',
      sealed_key TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, provider)
    );
    CREATE TABLE IF NOT EXISTS voice_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const aad = (kind: VoiceKind, provider: string) => `clawopt.voice:${kind}:${provider}`;
  const row = (kind: VoiceKind, provider: string) => sql.prepare('SELECT * FROM voice_providers WHERE kind = ? AND provider = ?').get(kind, provider) as ProviderRow | undefined;

  function readOptions(kind: VoiceKind, provider: string): VoiceProviderOptions {
    const existing = row(kind, provider);
    if (!existing) return {};
    try {
      return sanitizeProviderOptions(JSON.parse(existing.options));
    } catch {
      return {};
    }
  }

  function hasKey(kind: VoiceKind, provider: string): boolean {
    return Boolean(row(kind, provider)?.sealed_key);
  }

  function readKey(kind: VoiceKind, provider: string): string | null {
    const sealed = row(kind, provider)?.sealed_key;
    if (!sealed) return null;
    try {
      return box.unseal(JSON.parse(sealed), aad(kind, provider));
    } catch {
      return null;
    }
  }

  /** `apiKey`：undefined 或空串 = 不修改（凭据只进不出，空串不是清空）；清空走 `clearKey`。 */
  function saveProvider(kind: VoiceKind, provider: string, input: { options: unknown; apiKey?: unknown }): void {
    const options = sanitizeProviderOptions(input.options);
    const existing = row(kind, provider);
    let sealed = existing?.sealed_key ?? null;
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      sealed = JSON.stringify(box.seal(input.apiKey.trim(), aad(kind, provider)));
    }
    sql.prepare(`
      INSERT INTO voice_providers (kind, provider, options, sealed_key, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, provider) DO UPDATE SET options = excluded.options, sealed_key = excluded.sealed_key, updated_at = excluded.updated_at
    `).run(kind, provider, JSON.stringify(options), sealed, now());
  }

  function clearKey(kind: VoiceKind, provider: string): void {
    sql.prepare('UPDATE voice_providers SET sealed_key = NULL, updated_at = ? WHERE kind = ? AND provider = ?').run(now(), kind, provider);
  }

  function readConfig(): VoiceConfig {
    const rows = sql.prepare('SELECT key, value FROM voice_config').all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((entry) => [entry.key, entry.value]));
    const tts = map.get('ttsProvider') ?? null;
    const stt = map.get('sttProvider') ?? null;
    return {
      ttsProvider: tts && (TTS_PROVIDER_IDS as readonly string[]).includes(tts) ? tts : null,
      sttProvider: stt && (STT_PROVIDER_IDS as readonly string[]).includes(stt) ? stt : null,
      autoReadDefault: map.get('autoReadDefault') === '1',
    };
  }

  function writeConfig(patch: Partial<VoiceConfig>): void {
    const upsert = sql.prepare('INSERT INTO voice_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const remove = sql.prepare('DELETE FROM voice_config WHERE key = ?');
    sql.transaction(() => {
      if (patch.ttsProvider !== undefined) (patch.ttsProvider ? upsert.run('ttsProvider', patch.ttsProvider) : remove.run('ttsProvider'));
      if (patch.sttProvider !== undefined) (patch.sttProvider ? upsert.run('sttProvider', patch.sttProvider) : remove.run('sttProvider'));
      if (patch.autoReadDefault !== undefined) upsert.run('autoReadDefault', patch.autoReadDefault ? '1' : '0');
    })();
  }

  return { readOptions, hasKey, readKey, saveProvider, clearKey, readConfig, writeConfig };
}

export type VoiceSettingsStore = ReturnType<typeof createVoiceSettingsStore>;
