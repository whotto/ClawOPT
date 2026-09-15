/**
 * Agent 头像：PNG / JPEG / WebP，≤ 512 KiB，存 ClawOPT 自己的 SQLite。
 *
 * 不写引擎目录、不按路径出文件：取头像只认 Agent id，响应体来自库里的字节。
 * 类型以**文件头魔数**为准，不信客户端声明的 MIME（声明成 png 的 SVG 会带脚本）。
 */
import type { DB } from '../../core/db';
import { ControlInputError } from '../shared/control-http';

export const MAX_AVATAR_BYTES = 512 * 1024;

export function sniffImageMime(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** `data:image/png;base64,....` → 字节；格式、大小、魔数任一不对都拒绝。 */
export function decodeAvatarDataUrl(dataUrl: unknown): { mime: string; data: Buffer } {
  if (typeof dataUrl !== 'string') throw new ControlInputError('agents.avatarInvalid');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) throw new ControlInputError('agents.avatarInvalid');
  const data = Buffer.from(match[2], 'base64');
  if (data.length === 0) throw new ControlInputError('agents.avatarInvalid');
  if (data.length > MAX_AVATAR_BYTES) throw new ControlInputError('agents.avatarTooLarge', 413);
  const mime = sniffImageMime(data);
  if (!mime) throw new ControlInputError('agents.avatarInvalid');
  return { mime, data };
}

export function createAgentAvatarStore(deps: { db: DB; now?: () => number }) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;

  return {
    list(): Array<{ agentId: string; updatedAt: number }> {
      return (sql.prepare('SELECT agent_id, updated_at FROM agent_avatars ORDER BY agent_id').all() as Array<{ agent_id: string; updated_at: number }>)
        .map((row) => ({ agentId: row.agent_id, updatedAt: row.updated_at }));
    },
    get(agentId: string): { mime: string; data: Buffer; updatedAt: number } | null {
      const row = sql.prepare('SELECT mime, data, updated_at FROM agent_avatars WHERE agent_id = ?').get(agentId) as { mime: string; data: Buffer; updated_at: number } | undefined;
      return row ? { mime: row.mime, data: row.data, updatedAt: row.updated_at } : null;
    },
    set(agentId: string, dataUrl: unknown): void {
      const { mime, data } = decodeAvatarDataUrl(dataUrl);
      sql.prepare('INSERT INTO agent_avatars (agent_id, mime, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at')
        .run(agentId, mime, data, now());
    },
    remove(agentId: string): boolean {
      return sql.prepare('DELETE FROM agent_avatars WHERE agent_id = ?').run(agentId).changes > 0;
    },
    copy(fromAgentId: string, toAgentId: string): boolean {
      return sql.prepare('INSERT OR REPLACE INTO agent_avatars (agent_id, mime, data, updated_at) SELECT ?, mime, data, ? FROM agent_avatars WHERE agent_id = ?')
        .run(toAgentId, now(), fromAgentId).changes > 0;
    },
  };
}

export type AgentAvatarStore = ReturnType<typeof createAgentAvatarStore>;
