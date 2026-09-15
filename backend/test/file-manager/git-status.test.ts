/**
 * git 状态标注：porcelain v1 -z 解析、最强状态与后代计数、不可信仓库配置不执行 git status（真 git，若本机有）。
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { decorateEntries, gitDecorationsFor, hasUnsafeLocalConfig, parsePorcelainV1Z } from '../../src/workspace/files/manager/git-status';

describe('porcelain v1 -z', () => {
  it('解析修改、新增、删除、未跟踪、冲突与改名（原路径记为删除）', () => {
    const output = [' M src/a.ts', 'A  src/new.ts', ' D gone.md', '?? notes/todo.txt', 'UU merge.txt', 'R  docs/new-name.md', 'docs/old-name.md', '!! ignored.log', ''].join('\0');
    expect(parsePorcelainV1Z(output)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'gone.md', status: 'deleted' },
      { path: 'notes/todo.txt', status: 'untracked' },
      { path: 'merge.txt', status: 'conflicted' },
      { path: 'docs/old-name.md', status: 'deleted' },
      { path: 'docs/new-name.md', status: 'renamed' },
    ]);
  });

  it('目录取后代里最强的状态并计数；只看当前目录下的直接名字', () => {
    const changes = parsePorcelainV1Z(['?? src/x.ts', ' M src/deep/y.ts', 'UU src/z.ts', ' M other/q.ts', ''].join('\0'));
    expect(decorateEntries(changes, '', ['src', 'README.md'])).toEqual({ src: { status: 'conflicted', changedDescendants: 3 } });
    expect(decorateEntries(changes, 'src', ['x.ts', 'deep'])).toEqual({ 'x.ts': { status: 'untracked', changedDescendants: 0 }, deep: { status: 'modified', changedDescendants: 1 } });
  });

  it('本地配置里能执行命令的键（fsmonitor、过滤器、include、hooksPath）判为不安全', () => {
    expect(hasUnsafeLocalConfig('core.bare=false\ncore.fsmonitor=touch /tmp/pwn')).toBe(true);
    expect(hasUnsafeLocalConfig('filter.lfs.clean=git-lfs clean -- %f')).toBe(true);
    expect(hasUnsafeLocalConfig('include.path=../evil')).toBe(true);
    expect(hasUnsafeLocalConfig('core.repositoryformatversion=0\nremote.origin.url=x')).toBe(false);
  });
});

const gitAvailable = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!gitAvailable)('真 git 仓库', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

  const repo = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-fm-git-')));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'init');
    return { dir, git };
  };

  it('标注真实改动', async () => {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
    const result = await gitDecorationsFor(dir, ['src', 'new.txt']);
    expect(result).toMatchObject({ state: 'ok', byName: { src: { status: 'modified', changedDescendants: 1 }, 'new.txt': { status: 'untracked', changedDescendants: 0 } } });
  });

  it('仓库配置里有 core.fsmonitor 命令：不跑 status，也不执行它', async () => {
    const { dir, git } = repo();
    const marker = path.join(dir, 'pwned');
    git('config', 'core.fsmonitor', `touch ${marker}`);
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed');
    const result = await gitDecorationsFor(dir, ['src']);
    expect(result.state).toBe('unsafeConfig');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
