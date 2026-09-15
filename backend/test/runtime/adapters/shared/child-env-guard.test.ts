/**
 * 守卫：**每一个**编码类运行时的子进程环境里，白名单之外的变量一个都不许出现。
 *
 * 参考实现的最新提交把「合并好的整份进程环境」塞进每次隐藏运行的启动环境，白名单形同虚设——
 * ClawOPT 进程里的任何东西（`CLAWOPT_*`、别家服务的 key、云厂商凭据）都会流进一个会执行模型生成命令的 CLI。
 *
 * 这里对七个运行时 × 两种模式逐一起一次运行，拿执行器收到的 env 与允许集合比：
 * 允许 = 白名单（CHILD_ENV_ALLOWLIST + LC_*）∪ 这次启动自己设的变量（运行时 home 指针、代理令牌…）
 *       ∪ global 模式下这个运行时声明的凭据变量（按名字模式）。
 * 管理器用的是「把整份进程环境都合并进来」的假实现：证明适配器自己的那道过滤在起作用，不依赖管理器实现正确。
 *
 * 证明会红：① 把 `_shared/env.ts` 的 `buildChildEnv` 改成原样返回 `manager.childEnv(...)` 的结果，十四条全红；
 * ② 去掉 `NEVER_INHERITED`（`CLAWOPT_*` 排除），四条红：pi / opencode 的 global 凭据模式 `/_AUTH_TOKEN$/` 放出
 *    `CLAWOPT_AUTH_TOKEN`，dsh / hermes 的 `/_API_KEY$/` 放出 `CLAWOPT_UPSTREAM_API_KEY`——这是集成时这条守卫第一次跑就抓到的真漏洞。
 *    （Claude 的 `AWS_*` 是声明过的 Bedrock 凭据，按声明跳过，不算漏。）
 */
import { describe, expect, it } from 'vitest';
import { createCodingAgentAdapter } from '../../../../src/runtime/adapters/_shared/cli-adapter';
import { CODING_AGENT_DEFINITIONS } from '../../../../src/runtime/adapters/registry';
import { isAllowlistedEnvName } from '../../../../src/runtime/manager/path-env';
import { createRuntimeManager } from '../../../../src/runtime/manager';
import { SCOPED_PROVIDER, baseRequest, flushMicrotasks, harness, startRun } from '../_helpers/harness';

const PROCESS_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/user',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  CLAWOPT_AUTH_TOKEN: 'canary-clawopt-auth',
  CLAWOPT_DATA_DIR: '.clawopt-canary',
  CLAWOPT_UPSTREAM_API_KEY: 'sk-canary-clawopt-upstream',
  SECRET_TOKEN: 'canary-secret',
  AWS_SECRET_ACCESS_KEY: 'canary-aws',
  GITHUB_TOKEN: 'canary-github',
  DATABASE_URL: 'postgres://canary',
  OPENAI_API_KEY: 'sk-canary-openai-000000',
  ANTHROPIC_API_KEY: 'sk-ant-canary-000000',
  NPM_CONFIG_PREFIX: '/canary/prefix',
};

for (const definition of CODING_AGENT_DEFINITIONS) {
  const runtime = definition.descriptor.id;
  describe(`子进程环境白名单：${runtime}`, () => {
    for (const mode of definition.capabilities.proxyMode) {
      it(`${mode}：白名单外的变量不进子进程（管理器把整份环境都并进来也一样）`, async () => {
        const h = harness({ processEnv: PROCESS_ENV });
        // 漏风的管理器：childEnv 把整份进程环境都合并进来。
        h.manager.leakyEnv = { ...PROCESS_ENV };
        const adapter = createCodingAgentAdapter(definition, h.deps);
        const request = mode === 'scoped'
          ? baseRequest({ mode, provider: { ...SCOPED_PROVIDER, apiMode: runtime === 'hermes' || runtime === 'claude-code' ? 'anthropic_messages' : 'responses' } })
          : baseRequest({ mode });
        const run = startRun(adapter, request, { proxyMode: mode });
        const proc = await h.exec.next();
        const env = proc.spec.env;

        const offenders = Object.keys(env).filter((name) => {
          if (isAllowlistedEnvName(name)) return false;
          if (mode === 'global' && definition.globalCredentialEnv.some((pattern) => pattern.test(name))) return false;
          // 这次启动自己设的变量：名字不在进程环境里，或者值与进程环境里的不同（是适配器写的，不是继承的）。
          return name in PROCESS_ENV && env[name] === PROCESS_ENV[name];
        });
        expect(offenders, `${runtime} ${mode} 把进程环境里的变量漏进了子进程`).toEqual([]);
        for (const canary of ['SECRET_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'NPM_CONFIG_PREFIX']) {
          // global 模式下运行时声明过的凭据变量是有意放行的（Claude 的 Bedrock 要 AWS_*、OpenCode 的 GitHub Copilot 要 GITHUB_TOKEN）。
          if (mode === 'global' && definition.globalCredentialEnv.some((pattern) => pattern.test(canary))) continue;
          expect(env[canary], `${runtime} ${mode}: ${canary}`).toBeUndefined();
        }
        // ClawOPT 自己的变量**任何模式都不给**：运行时的凭据模式按名字放行（`_AUTH_TOKEN$`、`_API_KEY$`），
        // 一个 `CLAWOPT_AUTH_TOKEN` 就能顺着它漏出去。
        expect(Object.keys(env).filter((name) => name.startsWith('CLAWOPT_') && env[name] === PROCESS_ENV[name]), `${runtime} ${mode}`).toEqual([]);
        if (mode === 'scoped') {
          // scoped 连「看起来有用」的凭据也不给：残留登录会盖过代理。
          expect(env.OPENAI_API_KEY).toBeUndefined();
          if (env.ANTHROPIC_API_KEY !== undefined) expect(env.ANTHROPIC_API_KEY).not.toBe(PROCESS_ENV.ANTHROPIC_API_KEY);
        }

        run.abort.abort();
        proc.close(null, 'SIGINT');
        await flushMicrotasks(10);
      });
    }
  });
}

describe('子进程环境白名单：真实运行时管理器', () => {
  it('childEnv 只从白名单起步、只把 PATH 换成扩充版再叠 extra；包管理器变量不给 Agent', () => {
    const manager = createRuntimeManager({ dataDir: '/nonexistent/clawopt-runtime', env: PROCESS_ENV, includeHostBins: false });
    const env = manager.childEnv({ CODEX_HOME: '/r' });
    expect(Object.keys(env).filter((name) => !isAllowlistedEnvName(name) && name !== 'CODEX_HOME')).toEqual([]);
    expect(env.CODEX_HOME).toBe('/r');
    expect(env.PATH?.split(':')[0], '原 PATH 必须在最前').toBe('/usr/bin');
    manager.stop();
  });
});
