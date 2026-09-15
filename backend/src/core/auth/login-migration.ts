/**
 * 启动一次性任务：把多用户之前的「单一登录口令」迁成一个 super_admin 用户 `admin`。
 *
 * 判据（读的是库里**原始存储**的配置，不是合并了默认值的 `getConfig()`）：
 *
 * | 已有用户 | 存储的口令 | 登录开启 | 动作 |
 * |---|---|---|---|
 * | 有 | — | — | 跳过 |
 * | 无 | 非默认 | — | 建 admin，沿用该哈希 |
 * | 无 | 默认（123456）或无 | 开 | 建 admin，口令为 123456 且**必须先改口令**才能用任何接口 |
 * | 无 | 默认或无 | 关 | 不建（等管理员开启登录时设口令） |
 *
 * 第三行是在「不锁死已开启登录的老主机」和「不留默认凭据」之间取的：老主机上 123456
 * 本来就能登录，迁移后它仍能登录，但只够把口令改掉。
 */
import { hashPassword, isHashedPassword, verifyPassword } from './auth-store';
import type { UserStore } from './user-store';

export const LEGACY_DEFAULT_LOGIN_PASSWORD = '123456';
export const MIGRATED_SUPER_ADMIN_USERNAME = 'admin';

export type LoginMigrationOutcome =
  | { status: 'skipped'; reason: 'usersExist' | 'noPasswordAndLoginDisabled' }
  | { status: 'created'; username: string; mustChangePassword: boolean };

export type LoginMigrationDeps = {
  userStore: UserStore;
  /** 原始存储的 app_config JSON 文本（可能不存在）。 */
  readRawAppConfig: () => string | undefined;
};

export function migrateLegacyLoginPassword(deps: LoginMigrationDeps): LoginMigrationOutcome {
  const { userStore } = deps;
  if (userStore.count() > 0) return { status: 'skipped', reason: 'usersExist' };

  let raw: Record<string, unknown> = {};
  const text = deps.readRawAppConfig();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      // 读不懂的配置按「什么都没存」处理；configManager 也是这么降级的。
    }
  }

  const stored = typeof raw.loginPassword === 'string' ? raw.loginPassword : '';
  const loginEnabled = raw.loginEnabled === true;
  const storedIsDefault = !stored || verifyPassword(LEGACY_DEFAULT_LOGIN_PASSWORD, stored);

  if (storedIsDefault && !loginEnabled) return { status: 'skipped', reason: 'noPasswordAndLoginDisabled' };

  const passwordHash = stored
    ? (isHashedPassword(stored) ? stored : hashPassword(stored))
    : hashPassword(LEGACY_DEFAULT_LOGIN_PASSWORD);
  userStore.create({
    username: MIGRATED_SUPER_ADMIN_USERNAME,
    passwordHash,
    role: 'super_admin',
    mustChangePassword: storedIsDefault,
  });
  return { status: 'created', username: MIGRATED_SUPER_ADMIN_USERNAME, mustChangePassword: storedIsDefault };
}
