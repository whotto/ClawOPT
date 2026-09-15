/**
 * 日志查看：两路来源，同一种条目形状。
 *
 * - `gateway`：`openclaw logs --json --limit N`（经网关 RPC 读网关文件日志，逐行 JSON）；
 * - `clawopt`：本进程结构化日志的环形缓冲（`core/logger`，与 `/api/diagnostics` 同一份，进缓冲前已脱敏）。
 *
 * 网关日志的 `message` 常以 `{"subsystem":"gateway"} {...}` 这样的 JSON 前缀开头，这里剥掉前缀只留人话；
 * 整条再过一遍 `redactCliText`（家目录、令牌形状）——日志是最容易把凭据带出去的出口。
 */
import { type LogLevel, recentLogEntries } from '../../core/logger';
import { type OpenClawCliRunner, parseCliJsonLines, redactCliText } from '../../openclaw';
import { ControlInputError } from '../shared/control-http';

export type LogSource = 'gateway' | 'clawopt';
export type LogFilterLevel = 'all' | 'error' | 'warn' | 'info' | 'debug';

export type LogLine = { ts: string | null; level: string; source: LogSource; subsystem: string | null; message: string };

const LEVEL_RANK: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, warning: 3, error: 4, fatal: 5 };

/** 剥掉消息开头连续的 JSON 对象前缀。 */
export function stripJsonPrefixes(message: string): string {
  let rest = message.trimStart();
  for (let guard = 0; guard < 4 && rest.startsWith('{'); guard += 1) {
    let depth = 0;
    let end = -1;
    let inString = false;
    for (let index = 0; index < rest.length; index += 1) {
      const ch = rest[index];
      if (inString) {
        if (ch === '\\') index += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) break;
    rest = rest.slice(end + 1).trimStart();
  }
  return rest || message;
}

export function filterLogLines(lines: LogLine[], level: LogFilterLevel, query: string): LogLine[] {
  const min = level === 'all' ? -1 : LEVEL_RANK[level];
  const needle = query.trim().toLowerCase();
  return lines.filter((line) => {
    if (min >= 0 && (LEVEL_RANK[line.level] ?? LEVEL_RANK.info) < min) return false;
    if (needle && !`${line.subsystem ?? ''} ${line.message}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function parseLevel(value: unknown): LogFilterLevel {
  if (value === undefined || value === '' || value === 'all') return 'all';
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value;
  throw new ControlInputError('logs.invalidLevel');
}

export function createLogsService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function gatewayLines(limit: number): Promise<LogLine[]> {
    const { stdout } = await cli.run(['logs', '--json', '--limit', String(limit)], { timeoutMs: 30_000 });
    return parseCliJsonLines(stdout)
      .filter((entry) => entry.type === 'log')
      .map((entry) => ({
        ts: typeof entry.time === 'string' ? entry.time : null,
        level: typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info',
        source: 'gateway' as const,
        subsystem: typeof entry.subsystem === 'string' ? entry.subsystem : null,
        message: redactCliText(stripJsonPrefixes(typeof entry.message === 'string' ? entry.message : '')),
      }));
  }

  function clawoptLines(limit: number): LogLine[] {
    return recentLogEntries(limit).map((entry) => ({
      ts: entry.ts,
      level: entry.level as LogLevel,
      source: 'clawopt' as const,
      subsystem: entry.tag,
      message: entry.fields ? `${entry.msg} ${JSON.stringify(entry.fields)}` : entry.msg,
    }));
  }

  async function read(input: { source?: unknown; level?: unknown; q?: unknown; limit?: unknown }) {
    const source = input.source === 'clawopt' ? 'clawopt' : input.source === 'gateway' || input.source === undefined ? 'gateway' : null;
    if (!source) throw new ControlInputError('logs.invalidSource');
    const level = parseLevel(input.level);
    const limit = Math.min(2000, Math.max(10, Math.floor(Number(input.limit)) || 300));
    const query = typeof input.q === 'string' ? input.q.slice(0, 200) : '';
    const lines = source === 'gateway' ? await gatewayLines(limit) : clawoptLines(limit);
    return { source, level, lines: filterLogLines(lines, level, query) };
  }

  return { read };
}

export type LogsService = ReturnType<typeof createLogsService>;
