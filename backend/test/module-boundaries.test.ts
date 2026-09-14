/**
 * 模块边界检查脚本（scripts/check-module-boundaries.mjs）自己的守卫。
 *
 * 一个永远通过的边界检查比没有更糟：它让人以为边界有人守。所以这里三件事都要成立：
 * 违规样例必须被逐条认出来、合规样例必须通过、真实 backend/src 必须通过且确实解析到了导入。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-module-boundaries.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'module-boundaries');

function run(root?: string) {
  const args = [SCRIPT, ...(root ? ['--root', root] : [])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('check-module-boundaries', () => {
  it('违规样例：四类违规逐条报出，退出码 1', () => {
    const { status, output } = run(path.join(FIXTURES, 'violating'));
    expect(status).toBe(1);
    expect(output).toContain('core/db/db.ts:2  core 不得依赖业务模块');
    expect(output).toContain('control/helper.ts:2  跨模块导入必须经 barrel');
    expect(output).toContain('collab/rooms/room-service.ts:2  非路由文件不得引用路由文件 control/thing-routes.ts');
    expect(output).toContain('collab/rooms/room-service.ts:4  只有入口 src/index.ts 可以导入 bootstrap');
    expect(output).toContain('（4 处）');
  });

  it('注释与字符串里的 import 不算', () => {
    const { output } = run(path.join(FIXTURES, 'violating'));
    expect(output).not.toContain('room-service.ts:5');
    expect(output).not.toContain('room-service.ts:6');
    expect(output).not.toContain('room-service.ts:7');
  });

  it('合规样例通过（barrel 导入、core 内部互引、barrel 再导出路由、bootstrap 用路由）', () => {
    const { status, output } = run(path.join(FIXTURES, 'clean'));
    expect(output).toContain('模块边界检查通过');
    expect(status).toBe(0);
  });

  it('真实 backend/src 通过，且解析器确实读到了导入（不是空转）', async () => {
    const { status, output } = run();
    expect(output).toContain('模块边界检查通过');
    expect(status).toBe(0);

    const { parseImports } = await import(SCRIPT);
    const chatRoutes = fs.readFileSync(path.join(REPO, 'backend', 'src', 'collab', 'sessions', 'chat-routes.ts'), 'utf-8');
    const specs = (parseImports(chatRoutes) as Array<{ spec: string }>).map((entry) => entry.spec);
    expect(specs).toContain('../../control');
    expect(specs).toContain('./chat-constants');
    expect(specs.filter((spec) => spec.startsWith('.')).length).toBeGreaterThan(10);
  });
});
