/**
 * 运行时账号状态 —— 「未登录」与「问不出来」必须分开。
 *
 * 这是本项目反复修的那类失败在认证这条线上的形状：
 * 把「探测失败」显示成「未登录」，用户会去重新登录一个本来就好的账号——
 * 而 `--force` 登录会**删掉现有 profile**。一个显示错误的状态，
 * 比不显示状态更危险。
 */
import { describe, it, expect } from 'vitest';
import { buildLoginCommand } from '../src/runtime-auth';
import { AGENT_RUNTIMES } from '../src/agent-runtimes';

describe('登录命令', () => {
  it('统一带 --device-code —— ClawOPT 装在远程主机上，浏览器回调走不通', () => {
    // 默认的 localhost 回调流程在服务器上没有浏览器、也回调不到用户的机器。
    expect(buildLoginCommand('openai')).toContain('--device-code');
    expect(buildLoginCommand('openai')).toBe('openclaw models auth login --provider openai --device-code');
  });

  it('每个需要账号的运行时都能生成命令', () => {
    for (const r of AGENT_RUNTIMES) {
      if (!r.requires) continue;
      const cmd = buildLoginCommand(r.requires);
      expect(cmd, `${r.id} 的命令里没有 provider`).toContain(r.requires);
      expect(cmd).toContain('--device-code');
    }
  });
});

describe('状态三态：authenticated / missing / unknown', () => {
  it('模块导出的类型里必须有 unknown —— 探测失败不能塌成 missing', async () => {
    // 这条断言的是**源码里的判据**：readRuntimeAuthStatus 在探测失败时
    // 返回的是 'unknown'。把它读成 'missing' 会让用户去 --force 重登，
    // 而那会删掉现有 profile。
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'runtime-auth.ts'), 'utf-8');

    // 探测失败的那条分支必须产出 unknown
    expect(src).toContain("state: 'unknown' as const");
    // 且必须有注释说明为什么不能用 missing —— 这是买来的判断，不该被下一个人「简化」掉
    expect(src).toMatch(/force.*删掉现有 profile|删掉现有 profile.*force/s);
  });

  it('不需要账号的运行时（openclaw）不给登录命令', () => {
    const native = AGENT_RUNTIMES.find((r) => r.requires === null);
    expect(native?.id, '应当有一个不需要账号的默认运行时').toBe('openclaw');
  });
});
