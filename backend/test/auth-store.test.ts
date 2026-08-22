/**
 * 登录凭据与会话令牌。
 *
 * 这里守的是一次真实的安全缺陷：旧实现里 token = sha256(口令 + 写死的固定盐)，
 * 默认口令 123456 意味着令牌可被离线算出，且泄露一次永久有效。
 * 下面每个用例都对应一条「不能再回去」的性质。
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { AuthStore, hashPassword, isHashedPassword, readCookie, verifyPassword } from '../src/auth-store';

/** 内存版 DB 替身：只需要 getConfig/setConfig 两个方法。 */
function makeDb() {
  const store = new Map<string, string>();
  return {
    getConfig: (key: string) => store.get(key),
    setConfig: (key: string, value: string) => { store.set(key, value); },
    _store: store,
  } as any;
}

describe('口令存储', () => {
  it('哈希后不含明文，且同一口令两次哈希不同（每次随机盐）', () => {
    const a = hashPassword('correct-horse');
    const b = hashPassword('correct-horse');
    expect(a).not.toContain('correct-horse');
    expect(a).not.toEqual(b);
    expect(isHashedPassword(a)).toBe(true);
  });

  it('校验正确口令通过、错误口令不通过', () => {
    const stored = hashPassword('correct-horse');
    expect(verifyPassword('correct-horse', stored)).toBe(true);
    expect(verifyPassword('correct-horse ', stored)).toBe(false);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('迁移期仍能校验未哈希的明文口令', () => {
    expect(verifyPassword('legacy-pw', 'legacy-pw')).toBe(true);
    expect(verifyPassword('other', 'legacy-pw')).toBe(false);
  });
});

describe('会话令牌', () => {
  it('令牌不是口令的函数——换一个 store 重新签发也不相同', () => {
    const one = new AuthStore(makeDb()).issue().token;
    const two = new AuthStore(makeDb()).issue().token;
    expect(one).not.toEqual(two);
    // 且不等于旧算法的产物
    const legacy = crypto.createHash('sha256').update('123456_clawopt_salt').digest('hex');
    expect(one).not.toEqual(legacy);
    expect(one).toHaveLength(64);
  });

  it('签发的令牌可用，随机令牌不可用', () => {
    const store = new AuthStore(makeDb());
    const { token } = store.issue();
    expect(store.verify(token)).toBe(true);
    expect(store.verify('f'.repeat(64))).toBe(false);
    expect(store.verify('')).toBe(false);
  });

  it('吊销后立即失效', () => {
    const store = new AuthStore(makeDb());
    const { token } = store.issue();
    store.revoke(token);
    expect(store.verify(token)).toBe(false);
  });

  it('revokeAll 作废全部——改口令时靠它，否则改密码挡不住已泄露的令牌', () => {
    const store = new AuthStore(makeDb());
    const a = store.issue().token;
    const b = store.issue().token;
    store.revokeAll();
    expect(store.verify(a)).toBe(false);
    expect(store.verify(b)).toBe(false);
  });

  it('过期令牌不被接受', () => {
    const db = makeDb();
    const store = new AuthStore(db);
    const { token } = store.issue();
    // 直接把持久化记录改成已过期，再用新实例加载
    const records = JSON.parse(db.getConfig('auth_sessions')!);
    records[0].expiresAt = Date.now() - 1000;
    db.setConfig('auth_sessions', JSON.stringify(records));
    expect(new AuthStore(db).verify(token)).toBe(false);
  });

  it('会话跨进程重启存活（持久化到 DB）', () => {
    const db = makeDb();
    const { token } = new AuthStore(db).issue();
    expect(new AuthStore(db).verify(token)).toBe(true);
  });
});

describe('Cookie 解析', () => {
  it('取得出目标键，且不被相似前缀干扰', () => {
    expect(readCookie('a=1; clawopt_session=abc; b=2', 'clawopt_session')).toBe('abc');
    expect(readCookie('clawopt_session_other=zzz', 'clawopt_session')).toBe('');
    expect(readCookie(undefined, 'clawopt_session')).toBe('');
  });

  it('处理 URL 编码值', () => {
    expect(readCookie('clawopt_session=a%20b', 'clawopt_session')).toBe('a b');
  });
});
