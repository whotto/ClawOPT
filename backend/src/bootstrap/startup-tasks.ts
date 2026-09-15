/**
 * 启动一次性任务：数据修正、迁移这类「每台主机只该跑一次」的动作。
 *
 * 拆分前这类动作直接写在启动路径里、每次启动都跑（见 `startup-steps.ts`），
 * 只能靠「重复跑也无害」来兜底。新增的迁移不该再这样：有些修正跑两次就是破坏。
 *
 * ## 规则
 *
 * - 任务是有序清单 `{ id, scope, run }`，id 唯一；
 * - 完成记录落在 `$HOME/$CLAWOPT_DATA_DIR/startup-tasks.json`，经 SafeFileStore 锁内读写；
 * - 记录文件读不懂、形状不对、或同一 id 的 scope 对不上 → **整批拒跑**。
 *   记录坏了就无从知道哪些跑过，宁可不跑也不重跑；
 * - 按顺序执行，**第一个失败就停**，后面的不跑（后面的往往依赖前面的）；
 * - 日志只写任务 id 与 errorCode，**不写原始错误文本**——迁移失败的报错里常带着
 *   路径、配置片段甚至凭据。
 *
 * 登记表是 `buildStartupTasks(deps)` 的返回值：任务要用到上下文里的单例（库、用户表），
 * 所以登记表在上下文建好之后才构造。
 */
import { migrateLegacyLoginPassword, type UserStore } from '../core/auth';
import type { DB } from '../core/db';
import { sharedFileStore, type SafeFileStore } from '../core/files';

export type StartupTaskScope = 'clawopt-data' | 'openclaw-home';

export type StartupTask = {
  id: string;
  /** 任务改动的是哪一块状态。记录进完成表，与登记不符即视为记录不可信。 */
  scope: StartupTaskScope;
  run: () => void | Promise<void>;
};

export type StartupTaskRecord = { scope: StartupTaskScope; completedAt: string };
export type StartupTaskState = { version: 1; completed: Record<string, StartupTaskRecord> };

export type StartupTaskOutcome =
  | { status: 'ok'; ran: string[]; skipped: string[] }
  | { status: 'failed'; ran: string[]; skipped: string[]; failedTask: string; errorCode: string }
  | { status: 'refused'; errorCode: string };

export type StartupTaskDeps = {
  db: Pick<DB, 'getConfig'>;
  userStore: UserStore;
  log?: (message: string) => void;
};

/** 登记表。新任务只追加到末尾，已发布的任务不改 id、不删除、不调整顺序。 */
export function buildStartupTasks(deps: StartupTaskDeps): StartupTask[] {
  const log = deps.log ?? ((message: string) => console.log(message));
  return [
    {
      // P5a：单一登录口令 → super_admin 用户。判据与理由见 core/auth/login-migration.ts。
      id: 'auth.login-password-to-super-admin',
      scope: 'clawopt-data',
      run: () => {
        const outcome = migrateLegacyLoginPassword({ userStore: deps.userStore, readRawAppConfig: () => deps.db.getConfig('app_config') });
        log(`[StartupTasks] auth.login-password-to-super-admin: ${outcome.status === 'created' ? `created ${outcome.username}${outcome.mustChangePassword ? ' (must change password)' : ''}` : `skipped (${outcome.reason})`}`);
      },
    },
  ];
}

const SCOPES: ReadonlySet<string> = new Set(['clawopt-data', 'openclaw-home']);

export class StartupTaskError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'StartupTaskError';
    this.errorCode = errorCode;
  }
}

function errorCodeOf(error: unknown, fallback: string): string {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' && code ? code : fallback;
}

function validateState(value: unknown): StartupTaskState {
  const corrupt = () => new StartupTaskError('startupTasks.stateCorrupt', 'Startup task state has an unexpected shape');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw corrupt();
  const completed = record.completed;
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) throw corrupt();
  for (const entry of Object.values(completed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') throw corrupt();
    const { scope, completedAt } = entry as Record<string, unknown>;
    if (typeof scope !== 'string' || !SCOPES.has(scope) || typeof completedAt !== 'string') throw corrupt();
  }
  return value as StartupTaskState;
}

async function readState(store: SafeFileStore, statePath: string): Promise<StartupTaskState> {
  const text = await store.read(statePath);
  if (text === null) return { version: 1, completed: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StartupTaskError('startupTasks.stateCorrupt', 'Startup task state is not valid JSON');
  }
  return validateState(parsed);
}

function validateRegistry(tasks: StartupTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.id || !task.id.trim() || seen.has(task.id) || !SCOPES.has(task.scope)) {
      throw new StartupTaskError('startupTasks.invalidRegistry', 'Startup task registry has an empty, duplicate or unscoped id');
    }
    seen.add(task.id);
  }
}

export async function runStartupTasks(options: {
  tasks: StartupTask[];
  statePath: string;
  store?: SafeFileStore;
  log?: (message: string) => void;
  now?: () => Date;
}): Promise<StartupTaskOutcome> {
  const { tasks, statePath } = options;
  const store = options.store ?? sharedFileStore;
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? (() => new Date());

  let state: StartupTaskState;
  try {
    validateRegistry(tasks);
    state = await readState(store, statePath);
    for (const task of tasks) {
      const record = state.completed[task.id];
      if (record && record.scope !== task.scope) {
        throw new StartupTaskError('startupTasks.scopeMismatch', 'Recorded scope does not match the registered task');
      }
    }
  } catch (error) {
    const errorCode = errorCodeOf(error, 'startupTasks.stateUnreadable');
    log(`[StartupTasks] refused to run: ${errorCode}`);
    return { status: 'refused', errorCode };
  }

  const ran: string[] = [];
  const skipped: string[] = [];
  for (const task of tasks) {
    if (state.completed[task.id]) {
      skipped.push(task.id);
      continue;
    }
    try {
      await task.run();
      await store.updateJson<StartupTaskState>(statePath, (current) => {
        const base = current === null ? { version: 1 as const, completed: {} } : validateState(current);
        return {
          next: {
            version: 1,
            completed: { ...base.completed, [task.id]: { scope: task.scope, completedAt: now().toISOString() } },
          },
        };
      });
      ran.push(task.id);
      log(`[StartupTasks] task ${task.id} completed`);
    } catch (error) {
      const errorCode = errorCodeOf(error, 'startupTasks.taskFailed');
      log(`[StartupTasks] task ${task.id} failed: ${errorCode}`);
      return { status: 'failed', ran, skipped, failedTask: task.id, errorCode };
    }
  }
  return { status: 'ok', ran, skipped };
}
