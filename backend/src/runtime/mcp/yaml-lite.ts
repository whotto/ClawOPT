/**
 * 够用的 YAML 子集：MCP 编辑对话框里用户粘贴的 `{name: config}` 映射、hermes `config.yaml` 里的
 * `mcp_servers`、DSH `cordis.patch.yml` 的行。只认：缩进块映射、`- ` 块序列、行内 `[a, b]` / `{a: b}`、
 * 单双引号字符串、布尔 / 数字 / null、`#` 注释。锚点、多文档、块标量（`|` `>`）、`!!` 标签一律抛错，
 * 调用方回 400 或把那一项标成只读——**读不懂就不改用户文件**。
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlLiteError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlLiteError';
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function splitFlow(body: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (depth !== 0 || quote) throw new YamlLiteError('unbalanced flow collection', line);
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseScalar(raw: string, line: number): YamlValue {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (/^[|>]/.test(value) || value.startsWith('&') || value.startsWith('*') || value.startsWith('!!')) {
    throw new YamlLiteError('unsupported YAML feature', line);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      throw new YamlLiteError('invalid double-quoted string', line);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1), line).map((part) => parseScalar(part, line));
  if (value.startsWith('{') && value.endsWith('}')) {
    const out: Record<string, YamlValue> = {};
    for (const part of splitFlow(value.slice(1, -1), line)) {
      const colon = findMappingColon(part);
      if (colon < 0) throw new YamlLiteError('invalid flow mapping', line);
      out[unquoteKey(part.slice(0, colon))] = parseScalar(part.slice(colon + 1), line);
    }
    return out;
  }
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function unquoteKey(raw: string): string {
  const key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) return key.slice(1, -1);
  return key;
}

/** `key: value` 里那个冒号（引号外、后面是空白或行尾）。 */
function findMappingColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

export function parseYamlLite(text: string): YamlValue {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) {
      if (lines.length > 0) throw new YamlLiteError('multiple documents are not supported', index + 1);
      return;
    }
    const withoutComment = stripComment(raw);
    if (!withoutComment.trim()) return;
    if (/\t/.test(withoutComment.slice(0, withoutComment.length - withoutComment.trimStart().length))) {
      throw new YamlLiteError('tabs are not allowed for indentation', index + 1);
    }
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trim(), number: index + 1 });
  });
  if (lines.length === 0) return null;
  let position = 0;

  const parseBlock = (indent: number): YamlValue => {
    const first = lines[position];
    if (first.text.startsWith('- ') || first.text === '-') {
      const items: YamlValue[] = [];
      while (position < lines.length && lines[position].indent === indent && (lines[position].text.startsWith('- ') || lines[position].text === '-')) {
        const line = lines[position];
        const rest = line.text === '-' ? '' : line.text.slice(2);
        if (!rest.trim()) {
          position += 1;
          items.push(position < lines.length && lines[position].indent > indent ? parseBlock(lines[position].indent) : null);
          continue;
        }
        // `- key: value` 开头的内联映射：把这一行当成缩进 +2 的映射首行。
        if (findMappingColon(rest) > 0 && !rest.startsWith('[') && !rest.startsWith('{') && !rest.startsWith('"') && !rest.startsWith("'")) {
          lines[position] = { indent: indent + 2, text: rest, number: line.number };
          items.push(parseBlock(indent + 2));
          continue;
        }
        position += 1;
        items.push(parseScalar(rest, line.number));
      }
      return items;
    }
    const map: Record<string, YamlValue> = {};
    while (position < lines.length && lines[position].indent === indent) {
      const line = lines[position];
      if (line.text.startsWith('- ')) throw new YamlLiteError('unexpected sequence item', line.number);
      const colon = findMappingColon(line.text);
      if (colon <= 0) throw new YamlLiteError('expected key: value', line.number);
      const key = unquoteKey(line.text.slice(0, colon));
      const rest = line.text.slice(colon + 1).trim();
      position += 1;
      if (rest) {
        map[key] = parseScalar(rest, line.number);
      } else if (position < lines.length && lines[position].indent > indent) {
        map[key] = parseBlock(lines[position].indent);
      } else if (position < lines.length && lines[position].indent === indent && lines[position].text.startsWith('- ')) {
        map[key] = parseBlock(indent);
      } else {
        map[key] = null;
      }
    }
    if (position < lines.length && lines[position].indent > indent) throw new YamlLiteError('bad indentation', lines[position].number);
    return map;
  };

  const value = parseBlock(lines[0].indent);
  if (position < lines.length) throw new YamlLiteError('bad indentation', lines[position].number);
  return value;
}

function yamlScalar(value: YamlValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_./@-][A-Za-z0-9_ ./@:-]*$/.test(value) && !/^(true|false|null|~|-?\d)/i.test(value) && !value.includes(': ') && !value.endsWith(':')
      ? value
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function stringifyYamlLite(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
        const body = stringifyYamlLite(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      if (Array.isArray(item)) return `${pad}- ${JSON.stringify(item)}\n`;
      return `${pad}- ${yamlScalar(item as YamlValue)}\n`;
    }).join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}\n`;
    return entries.map(([key, item]) => {
      const safeKey = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
      if (item && typeof item === 'object' && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)) {
        return `${pad}${safeKey}:\n${stringifyYamlLite(item, indent + 2)}`;
      }
      return `${pad}${safeKey}: ${Array.isArray(item) ? '[]' : item && typeof item === 'object' ? '{}' : yamlScalar(item as YamlValue)}\n`;
    }).join('');
  }
  return `${pad}${yamlScalar(value)}\n`;
}
