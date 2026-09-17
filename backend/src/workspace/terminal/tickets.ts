/**
 * 终端 WebSocket 的一次性票据（spec 07 §3.1：不把长期令牌放进 WS 的 URL）。
 *
 * - 32 字节随机数，只存 sha256，默认 30 秒过期；
 * - 绑定签发它的用户（userId / 隐式主人），换一个用户拿着它连接不算数；
 * - **一次性**：核对时先删再比，比对失败也作废（不给重试猜测的机会）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const TERMINAL_TICKET_TTL_MS = 30_000;
const MAX_OUTSTANDING_TICKETS = 256;

export type TicketOwner = { userKey: string; username: string | null };

type StoredTicket = { hash: Buffer; owner: TicketOwner; expiresAt: number };

const hashTicket = (ticket: string) => createHash('sha256').update(ticket, 'utf8').digest();

export class TerminalTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(private readonly options: { ttlMs?: number; now?: () => number } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  issue(owner: TicketOwner): { ticket: string; expiresAt: number } {
    this.sweep();
    if (this.tickets.size >= MAX_OUTSTANDING_TICKETS) {
      // 攒着不用的票据太多：丢掉最早的，不无限增长。
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    const hash = hashTicket(ticket);
    const expiresAt = this.now() + (this.options.ttlMs ?? TERMINAL_TICKET_TTL_MS);
    this.tickets.set(hash.toString('hex'), { hash, owner, expiresAt });
    return { ticket, expiresAt };
  }

  /** 核对并作废。返回 null 表示无效（不存在、过期、已用过、换了用户）。 */
  consume(ticket: unknown, expected: TicketOwner): TicketOwner | null {
    if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 128) return null;
    const hash = hashTicket(ticket);
    const key = hash.toString('hex');
    const stored = this.tickets.get(key);
    if (!stored) return null;
    this.tickets.delete(key);
    if (!timingSafeEqual(stored.hash, hash)) return null;
    if (stored.expiresAt <= this.now()) return null;
    if (stored.owner.userKey !== expected.userKey) return null;
    return stored.owner;
  }

  outstanding(): number {
    this.sweep();
    return this.tickets.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, stored] of this.tickets) if (stored.expiresAt <= now) this.tickets.delete(key);
  }
}
