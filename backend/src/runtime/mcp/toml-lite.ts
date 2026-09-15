/**
 * 够用的 TOML 子集：读出 `[mcp_servers.*]` 这类表、按表的行区间做删改，写出 MCP 表。
 *
 * 为什么不引依赖：共享的 node_modules 在几个并行分支之间共用，新增依赖会互相踩；
 * 我们只需要表头、键值（字符串 / 数组 / 内联表 / 布尔 / 数字）与行号，不需要完整的 TOML 语义。
 * 认不出的写法抛 `TomlLiteError`——调用方回 400，**绝不在读不懂的时候覆盖用户文件**。
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

export class TomlLiteError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'TomlLiteError';
  }
}

export interface TomlTable {
  /** 表头路径，如 `['mcp_servers', 'github']`；根表为空数组。 */
  path: string[];
  /** 表头所在行（根表为 -1）与表内容的结束行（不含），0 起。 */
  headerLine: number;
  endLine: number;
  values: Record<string, TomlValue>;
  isArrayTable: boolean;
}

class Cursor {
  index = 0;
  constructor(readonly text: string) {}
  get line(): number {
    return this.text.slice(0, this.index).split('\n').length;
  }
  peek(offset = 0): string {
    return this.text[this.index + offset] ?? '';
  }
  startsWith(token: string): boolean {
    return this.text.startsWith(token, this.index);
  }
  skipInline(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.index += 1;
  }
  skipWhitespaceAndComments(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') this.index += 1;
      else if (ch === '#') while (this.index < this.text.length && this.peek() !== '\n') this.index += 1;
      else break;
    }
  }
}

function parseKeyPart(cursor: Cursor): string {
  cursor.skipInline();
  const ch = cursor.peek();
  if (ch === '"' || ch === "'") return parseString(cursor) as string;
  const match = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.index));
  if (!match) throw new TomlLiteError('invalid key', cursor.line);
  cursor.index += match[0].length;
  return match[0];
}

function parseDottedKey(cursor: Cursor): string[] {
  const parts = [parseKeyPart(cursor)];
  cursor.skipInline();
  while (cursor.peek() === '.') {
    cursor.index += 1;
    parts.push(parseKeyPart(cursor));
    cursor.skipInline();
  }
  return parts;
}

function parseString(cursor: Cursor): string {
  if (cursor.startsWith('"""') || cursor.startsWith("'''")) {
    const quote = cursor.text.slice(cursor.index, cursor.index + 3);
    const end = cursor.text.indexOf(quote, cursor.index + 3);
    if (end < 0) throw new TomlLiteError('unterminated multi-line string', cursor.line);
    let body = cursor.text.slice(cursor.index + 3, end);
    cursor.index = end + 3;
    if (body.startsWith('\n')) body = body.slice(1);
    return quote === '"""' ? unescapeBasic(body) : body;
  }
  const quote = cursor.peek();
  cursor.index += 1;
  let out = '';
  while (cursor.index < cursor.text.length) {
    const ch = cursor.peek();
    if (ch === '\n') break;
    if (ch === quote) {
      cursor.index += 1;
      return quote === '"' ? unescapeBasic(out) : out;
    }
    if (ch === '\\' && quote === '"') {
      out += ch + cursor.peek(1);
      cursor.index += 2;
      continue;
    }
    out += ch;
    cursor.index += 1;
  }
  throw new TomlLiteError('unterminated string', cursor.line);
}

function unescapeBasic(value: string): string {
  return value.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, esc: string) => {
    if (esc[0] === 'u' || esc[0] === 'U') return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' } as Record<string, string>)[esc] ?? esc;
  });
}

function parseValue(cursor: Cursor): TomlValue {
  cursor.skipInline();
  const ch = cursor.peek();
  if (ch === '"' || ch === "'") return parseString(cursor);
  if (ch === '[') {
    cursor.index += 1;
    const items: TomlValue[] = [];
    for (;;) {
      cursor.skipWhitespaceAndComments();
      if (cursor.peek() === ']') {
        cursor.index += 1;
        return items;
      }
      items.push(parseValue(cursor));
      cursor.skipWhitespaceAndComments();
      if (cursor.peek() === ',') cursor.index += 1;
      else if (cursor.peek() !== ']') throw new TomlLiteError('invalid array', cursor.line);
    }
  }
  if (ch === '{') {
    cursor.index += 1;
    const table: Record<string, TomlValue> = {};
    for (;;) {
      cursor.skipInline();
      if (cursor.peek() === '}') {
        cursor.index += 1;
        return table;
      }
      const key = parseDottedKey(cursor);
      cursor.skipInline();
      if (cursor.peek() !== '=') throw new TomlLiteError('expected = in inline table', cursor.line);
      cursor.index += 1;
      assignPath(table, key, parseValue(cursor), cursor.line);
      cursor.skipInline();
      if (cursor.peek() === ',') cursor.index += 1;
      else if (cursor.peek() !== '}') throw new TomlLiteError('invalid inline table', cursor.line);
    }
  }
  const match = /^[^\s,\]}#]+/.exec(cursor.text.slice(cursor.index));
  if (!match) throw new TomlLiteError('missing value', cursor.line);
  cursor.index += match[0].length;
  const raw = match[0];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const numeric = Number(raw.replace(/_/g, ''));
  return Number.isFinite(numeric) && /^[+-]?[\d_.eE+-]+$|^0x/.test(raw) ? numeric : raw;
}

function assignPath(target: Record<string, TomlValue>, keys: string[], value: TomlValue, line: number): void {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === undefined) node[key] = {};
    else if (typeof next !== 'object' || Array.isArray(next)) throw new TomlLiteError('key conflicts with a value', line);
    node = node[key] as Record<string, TomlValue>;
  }
  node[keys[keys.length - 1]] = value;
}

export function parseTomlTables(text: string): TomlTable[] {
  const cursor = new Cursor(text);
  const lineOf = (index: number) => text.slice(0, index).split('\n').length - 1;
  const tables: TomlTable[] = [{ path: [], headerLine: -1, endLine: 0, values: {}, isArrayTable: false }];
  for (;;) {
    cursor.skipWhitespaceAndComments();
    if (cursor.index >= text.length) break;
    if (cursor.peek() === '[') {
      const isArrayTable = cursor.startsWith('[[');
      const headerLine = lineOf(cursor.index);
      cursor.index += isArrayTable ? 2 : 1;
      const tablePath = parseDottedKey(cursor);
      cursor.skipInline();
      if (!cursor.startsWith(isArrayTable ? ']]' : ']')) throw new TomlLiteError('invalid table header', cursor.line);
      cursor.index += isArrayTable ? 2 : 1;
      tables.push({ path: tablePath, headerLine, endLine: 0, values: {}, isArrayTable });
      continue;
    }
    const key = parseDottedKey(cursor);
    cursor.skipInline();
    if (cursor.peek() !== '=') throw new TomlLiteError('expected =', cursor.line);
    cursor.index += 1;
    const value = parseValue(cursor);
    assignPath(tables[tables.length - 1].values, key, value, cursor.line);
    cursor.skipInline();
    if (cursor.peek() === '#') while (cursor.index < text.length && cursor.peek() !== '\n') cursor.index += 1;
    if (cursor.index < text.length && cursor.peek() !== '\n' && cursor.peek() !== '\r') throw new TomlLiteError('unexpected content after value', cursor.line);
  }
  const lines = text.split('\n').length;
  for (let i = 0; i < tables.length; i += 1) {
    const next = tables[i + 1];
    tables[i].endLine = next ? next.headerLine : lines;
  }
  return tables;
}

/** 表头里的一段：裸键能表达就裸写，否则加引号。 */
export function tomlKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : tomlString(part);
}

export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

export function tomlInline(value: TomlValue): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(', ')}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlInline(v)}`).join(', ')} }`;
}
