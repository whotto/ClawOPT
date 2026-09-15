/**
 * 生成 / 过滤 TOML（Codex 与 Grok 的配置文件）所需的最小工具。
 *
 * 不引入 TOML 解析库：我们只**写**自己的块，并对用户文件做「按表头与顶层键」的过滤。
 * 过滤器按引号与方括号配对扫描，所以多行数组、多行字符串不会被从中间切开。
 */
import type { ManagedMcpServer } from '../_platform-types';

export function tomlString(value: string): string {
  // JSON 的基本字符串转义是 TOML 基本字符串的子集（\" \\ \n \t \uXXXX）。
  return JSON.stringify(value);
}

/** TOML 裸键只允许 [A-Za-z0-9_-]；其余一律加引号。 */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

export function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  return '""';
}

/** MCP 服务名收成安全的裸键（`-c mcp_servers.<name>=…` 按点切路径，名字里不能有点）。 */
export function safeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'server';
}

export function mcpServerTable(server: ManagedMcpServer, options: { startupTimeoutSec?: number; toolTimeoutSec?: number } = {}): Record<string, unknown> {
  const table: Record<string, unknown> = server.transport === 'http'
    ? { url: server.url ?? '', ...(server.headers && Object.keys(server.headers).length ? { http_headers: server.headers } : {}) }
    : { command: server.command ?? '', args: server.args ?? [], ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}) };
  if (options.startupTimeoutSec) table.startup_timeout_sec = options.startupTimeoutSec;
  if (options.toolTimeoutSec) table.tool_timeout_sec = options.toolTimeoutSec;
  return table;
}

/** `[mcp_servers.<name>]` 块。 */
export function mcpServersToml(servers: readonly ManagedMcpServer[], options: { startupTimeoutSec?: number; toolTimeoutSec?: number; urlKey?: string } = {}): string {
  const blocks: string[] = [];
  for (const server of servers) {
    const table = mcpServerTable(server, options);
    const lines = [`[mcp_servers.${safeMcpName(server.name)}]`];
    for (const [key, value] of Object.entries(table)) lines.push(`${key} = ${tomlValue(value)}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export interface TomlFilterOptions {
  /** 顶层要去掉的键（运行时自己管的那些）。 */
  dropTopLevelKeys: ReadonlySet<string>;
  /** 表头（不含方括号，如 `model_providers.custom`）命中就整段去掉。 */
  dropSection(header: string): boolean;
}

/**
 * 过滤用户的 TOML：按行扫描，跟踪「当前表头」与「是否在多行值里」。
 * 多行值（未闭合的 `[`、`"""`、`'''`）的续行跟随它的起始行一起保留或丢弃。
 */
export function filterToml(text: string, options: TomlFilterOptions): string {
  const out: string[] = [];
  let section: string | null = null;
  let dropSection = false;
  let dropValue = false;
  let depth = 0;
  let inTripleBasic = false;
  let inTripleLiteral = false;

  const scan = (line: string) => {
    let i = 0;
    while (i < line.length) {
      if (inTripleBasic) {
        const end = line.indexOf('"""', i);
        if (end < 0) return;
        inTripleBasic = false;
        i = end + 3;
        continue;
      }
      if (inTripleLiteral) {
        const end = line.indexOf("'''", i);
        if (end < 0) return;
        inTripleLiteral = false;
        i = end + 3;
        continue;
      }
      const ch = line[i];
      if (ch === '#') return;
      if (line.startsWith('"""', i)) { inTripleBasic = true; i += 3; continue; }
      if (line.startsWith("'''", i)) { inTripleLiteral = true; i += 3; continue; }
      if (ch === '"') {
        i += 1;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i += 1;
        continue;
      }
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
      i += 1;
    }
  };

  for (const line of text.split('\n')) {
    const continuing = depth > 0 || inTripleBasic || inTripleLiteral;
    if (continuing) {
      if (!dropSection && !dropValue) out.push(line);
      scan(line);
      continue;
    }
    dropValue = false;
    const trimmed = line.trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(trimmed);
    if (header) {
      section = header[1].replace(/\s+/g, '');
      dropSection = options.dropSection(section);
      if (!dropSection) out.push(line);
      continue;
    }
    if (dropSection) {
      scan(line.slice(line.indexOf('=') + 1));
      continue;
    }
    if (section === null) {
      const key = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=/.exec(trimmed);
      if (key && options.dropTopLevelKeys.has(key[1].replace(/^"|"$/g, ''))) {
        dropValue = true;
        scan(line.slice(line.indexOf('=') + 1));
        continue;
      }
    }
    out.push(line);
    const eq = line.indexOf('=');
    if (eq >= 0) scan(line.slice(eq + 1));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
