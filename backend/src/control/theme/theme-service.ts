/**
 * 每用户主题（P6，spec 07 §2.28、spec 08 §1.6）：明暗（浅色 / 深色 / 跟随系统）× 强调色 × 文字色 × 字号 × 背景图。
 *
 * - 按用户存（登录关闭时的隐式主人记在 `implicit` 名下），前端把它缓存在本机，下次首帧挂载前就生效；
 * - 颜色只收 `#rrggbb`（小写化），字号 12–20 的整数；不认识的字段一律拒绝，而不是悄悄丢掉；
 * - 背景图按**魔数**判类型（PNG / JPEG / WEBP / GIF），不信请求头的 Content-Type；上限 5 MB；
 *   字节存 SQLite（BLOB），不落散文件：备份随库走，也不给 fs 调用点棘轮添一处写入；
 * - 版本号：每次保存换新值，前端据此让缓存失效（背景图 URL 带版本号，换图不吃浏览器缓存）。
 */
import crypto from 'crypto';

import type { DB } from '../../core/db';
import { ControlInputError } from '../shared/control-http';

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_FONT_SIZE_MIN = 12;
export const THEME_FONT_SIZE_MAX = 20;
export const THEME_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;

export type UserTheme = {
  mode: ThemeMode;
  accentColor: string | null;
  textColor: string | null;
  fontSize: number | null;
  background: { mime: string; size: number; revision: string } | null;
  revision: string;
  updatedAt: number | null;
};

export const DEFAULT_THEME: UserTheme = {
  mode: 'light',
  accentColor: null,
  textColor: null,
  fontSize: null,
  background: null,
  revision: 'default',
  updatedAt: null,
};

type ThemeRow = {
  user_key: string;
  mode: string;
  accent_color: string | null;
  text_color: string | null;
  font_size: number | null;
  revision: string;
  updated_at: number;
};

type BackgroundRow = { user_key: string; mime: string; size: number; revision: string; data?: Buffer };

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function normalizeHexColor(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ControlInputError(code);
  const text = value.trim().toLowerCase();
  const expanded = /^#[0-9a-f]{3}$/.test(text) ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}` : text;
  if (!HEX_COLOR.test(expanded)) throw new ControlInputError(code);
  return expanded;
}

/** 背景图的真实类型：只认魔数。 */
export function sniffBackgroundMime(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

const ALLOWED_FIELDS = new Set(['mode', 'accentColor', 'textColor', 'fontSize']);

export function parseThemeInput(body: unknown): Pick<UserTheme, 'mode' | 'accentColor' | 'textColor' | 'fontSize'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ControlInputError('theme.invalid');
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED_FIELDS.has(key) && key !== 'revision');
  if (unknown.length) throw new ControlInputError('theme.invalid', 400, { fields: unknown.join(',') });
  const mode = record.mode === undefined ? 'light' : record.mode;
  if (typeof mode !== 'string' || !(THEME_MODES as readonly string[]).includes(mode)) throw new ControlInputError('theme.invalidMode');
  let fontSize: number | null = null;
  if (record.fontSize !== null && record.fontSize !== undefined && record.fontSize !== '') {
    const value = Number(record.fontSize);
    if (!Number.isInteger(value) || value < THEME_FONT_SIZE_MIN || value > THEME_FONT_SIZE_MAX) throw new ControlInputError('theme.invalidFontSize');
    fontSize = value;
  }
  return {
    mode: mode as ThemeMode,
    accentColor: normalizeHexColor(record.accentColor, 'theme.invalidColor'),
    textColor: normalizeHexColor(record.textColor, 'theme.invalidColor'),
    fontSize,
  };
}

export function themeUserKey(identity: { userId: number | null; implicit?: boolean }): string {
  return typeof identity.userId === 'number' ? `u:${identity.userId}` : 'implicit';
}

export function createThemeService(deps: { db: DB; now?: () => number }) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_themes (
      user_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('light', 'dark', 'system')),
      accent_color TEXT,
      text_color TEXT,
      font_size INTEGER,
      revision TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_theme_backgrounds (
      user_key TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL,
      revision TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const newRevision = () => crypto.randomBytes(8).toString('hex');

  function get(userKey: string): UserTheme {
    const row = sql.prepare('SELECT * FROM user_themes WHERE user_key = ?').get(userKey) as ThemeRow | undefined;
    const background = sql.prepare('SELECT user_key, mime, size, revision FROM user_theme_backgrounds WHERE user_key = ?').get(userKey) as BackgroundRow | undefined;
    const base: UserTheme = row
      ? {
        mode: (THEME_MODES as readonly string[]).includes(row.mode) ? row.mode as ThemeMode : 'light',
        accentColor: row.accent_color,
        textColor: row.text_color,
        fontSize: row.font_size,
        background: null,
        revision: row.revision,
        updatedAt: row.updated_at,
      }
      : { ...DEFAULT_THEME };
    if (background) {
      base.background = { mime: background.mime, size: background.size, revision: background.revision };
      base.revision = `${base.revision}.${background.revision}`;
    }
    return base;
  }

  function save(userKey: string, body: unknown): UserTheme {
    const input = parseThemeInput(body);
    sql.prepare(`
      INSERT INTO user_themes (user_key, mode, accent_color, text_color, font_size, revision, updated_at)
      VALUES (@userKey, @mode, @accentColor, @textColor, @fontSize, @revision, @updatedAt)
      ON CONFLICT(user_key) DO UPDATE SET mode = excluded.mode, accent_color = excluded.accent_color, text_color = excluded.text_color,
        font_size = excluded.font_size, revision = excluded.revision, updated_at = excluded.updated_at
    `).run({ userKey, ...input, revision: newRevision(), updatedAt: now() });
    return get(userKey);
  }

  function reset(userKey: string): UserTheme {
    sql.prepare('DELETE FROM user_themes WHERE user_key = ?').run(userKey);
    sql.prepare('DELETE FROM user_theme_backgrounds WHERE user_key = ?').run(userKey);
    return get(userKey);
  }

  function setBackground(userKey: string, data: unknown): UserTheme {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new ControlInputError('theme.backgroundInvalid');
    if (data.length > THEME_BACKGROUND_MAX_BYTES) throw new ControlInputError('theme.backgroundTooLarge', 413);
    const mime = sniffBackgroundMime(data);
    if (!mime) throw new ControlInputError('theme.backgroundInvalid');
    sql.prepare(`
      INSERT INTO user_theme_backgrounds (user_key, mime, size, data, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET mime = excluded.mime, size = excluded.size, data = excluded.data, revision = excluded.revision, updated_at = excluded.updated_at
    `).run(userKey, mime, data.length, data, newRevision(), now());
    return get(userKey);
  }

  function readBackground(userKey: string): { mime: string; data: Buffer; revision: string } | null {
    const row = sql.prepare('SELECT mime, data, revision FROM user_theme_backgrounds WHERE user_key = ?').get(userKey) as { mime: string; data: Buffer; revision: string } | undefined;
    return row ?? null;
  }

  function removeBackground(userKey: string): UserTheme {
    sql.prepare('DELETE FROM user_theme_backgrounds WHERE user_key = ?').run(userKey);
    return get(userKey);
  }

  return { get, save, reset, setBackground, readBackground, removeBackground };
}

export type ThemeService = ReturnType<typeof createThemeService>;
