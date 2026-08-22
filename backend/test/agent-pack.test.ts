/**
 * .clawpack 包的解析与写入。
 *
 * 这是唯一接受**外部上传文件**的入口，解析器一旦回归，后果不是报错而是
 * 「导入损坏」或「安全绕过」。用例按真实攻击面组织，每条都对应实测过的问题。
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  MAX_PACK_BYTES,
  PackError,
  assertSafeRelPath,
  buildPack,
  parsePack,
  sanitizeFileName,
  serializePack,
  writeAgentFiles,
  type PackAgent,
} from '../src/agent-pack';

function makeAgent(files: PackAgent['files'] = []): PackAgent {
  return { id: 'demo', name: '演示', skills: [], files };
}

function makePack(agents: PackAgent[]) {
  return buildPack({
    kind: 'agent', name: '演示', summary: '', appVersion: '0.0.0',
    agents, team: null, options: {}, warnings: [],
  });
}

describe('路径闸门', () => {
  it('放行白名单内的路径', () => {
    for (const p of ['SOUL.md', 'AGENTS.md', 'skills/x/SKILL.md', 'reference/a.md', 'avatars/a.png']) {
      expect(() => assertSafeRelPath(p)).not.toThrow();
    }
  });

  it('拒绝目录穿越与绝对路径', () => {
    for (const p of ['../evil.sh', 'skills/../../evil', '/etc/passwd', 'C:\\x', 'a\\b', 'skills/../..']) {
      expect(() => assertSafeRelPath(p)).toThrow(PackError);
    }
  });

  it('拒绝白名单之外的目录与根文件', () => {
    expect(() => assertSafeRelPath('memory/2026-01-01.md')).toThrow(PackError);   // 私人日志不进包
    expect(() => assertSafeRelPath('auth-profiles.json')).toThrow(PackError);
    expect(() => assertSafeRelPath('.env')).toThrow(PackError);
  });
});

describe('往返一致性', () => {
  it('导出再解析，内容逐字节相同', () => {
    const files = [
      { path: 'SOUL.md', encoding: 'utf8' as const, content: '# 灵魂\n中文内容', bytes: 20 },
      { path: 'avatars/a.png', encoding: 'base64' as const, content: Buffer.from([1, 2, 3]).toString('base64'), bytes: 3 },
    ];
    const parsed = parsePack(serializePack(makePack([makeAgent(files)])));
    expect(parsed.agents[0].files).toEqual(files);
    expect(parsed.kind).toBe('agent');
  });

  it('未压缩的纯 JSON 也能解析（gist 分享走的就是这条）', () => {
    const raw = Buffer.from(JSON.stringify(makePack([makeAgent()])), 'utf-8');
    expect(parsePack(raw).format).toBe('clawpack');
  });
});

describe('拒绝恶意或畸形的包', () => {
  it('拒绝解压炸弹', () => {
    const huge = JSON.stringify({
      format: 'clawpack', formatVersion: 1, kind: 'agent', exportedAt: '', exportedBy: {},
      manifest: {}, team: null,
      agents: [{ id: 'bomb', name: 'b', skills: [], files: [{ path: 'SOUL.md', encoding: 'utf8', content: 'A'.repeat(60 * 1024 * 1024), bytes: 1 }] }],
    });
    const bomb = zlib.gzipSync(Buffer.from(huge), { level: 9 });
    expect(bomb.byteLength).toBeLessThan(MAX_PACK_BYTES);      // 压缩后很小
    expect(() => parsePack(bomb)).toThrow(/tooLarge/);          // 但解开会超限
  });

  it('拒绝路径穿越的包', () => {
    const evil = makePack([makeAgent([{ path: '../../evil.sh', encoding: 'utf8', content: 'x', bytes: 1 }])]);
    expect(() => parsePack(Buffer.from(JSON.stringify(evil)))).toThrow(PackError);
  });

  it('拒绝非法的智能体 ID（会变成目录名）', () => {
    const evil = makePack([{ ...makeAgent(), id: '../escape' }]);
    expect(() => parsePack(Buffer.from(JSON.stringify(evil)))).toThrow(/packs\.invalidAgentId/);
  });

  it('拒绝不是包的东西与更高的格式版本', () => {
    expect(() => parsePack(Buffer.from('{"hello":1}'))).toThrow(/notAPack/);
    expect(() => parsePack(Buffer.from('not json'))).toThrow(/unreadable/);
    const future = { ...makePack([makeAgent()]), formatVersion: 99 };
    expect(() => parsePack(Buffer.from(JSON.stringify(future)))).toThrow(/versionTooNew/);
  });
});

describe('写入工作区', () => {
  it('按相对路径落盘，二进制正确还原', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packtest-'));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const written = writeAgentFiles(makeAgent([
        { path: 'SOUL.md', encoding: 'utf8', content: '灵魂', bytes: 6 },
        { path: 'skills/a/SKILL.md', encoding: 'utf8', content: 'skill', bytes: 5 },
        { path: 'avatars/a.png', encoding: 'base64', content: png.toString('base64'), bytes: 4 },
      ]), dir);
      expect(written).toBe(3);
      expect(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8')).toBe('灵魂');
      expect(fs.readFileSync(path.join(dir, 'avatars/a.png'))).toEqual(png);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入时再次拦截越界路径（不依赖调用方已经校验过）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packtest-'));
    try {
      expect(() => writeAgentFiles(
        makeAgent([{ path: '../escaped.md', encoding: 'utf8', content: 'x', bytes: 1 }]), dir,
      )).toThrow(PackError);
      expect(fs.existsSync(path.join(path.dirname(dir), 'escaped.md'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('文件名清洗', () => {
  it('去掉路径分隔符与危险字符，保留中文', () => {
    expect(sanitizeFileName('a/b\\c')).not.toMatch(/[\\/]/);
    expect(sanitizeFileName('科学决策')).toBe('科学决策');
    expect(sanitizeFileName('')).toBe('clawpack');
  });
});
