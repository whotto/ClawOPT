/**
 * DeepSeek Harness（`@deepseek-ai/dsh`）：描述符、能力、事实来源表。
 *
 * 对着隔离安装的 `dsh` 0.1.5-rc.1 与官方仓库 deepseek-ai/deepseek-harness@dsh-v0.1.5-rc.1 核对（2026-09-15）：
 * - `dsh --profile acp` 就是原生 ACP 适配器（initialize → session/new|resume → session/set_config_option → session/prompt → session/close）；
 *   **不需要** spec 里那套「生成私有 Web 派生 profile + 给 ACP 适配器打补丁」——那是为更老的版本缝能力；
 * - MCP 经 `session/new|resume` 的 `mcpServers` 注入（stdio / http，拒 SSE），不写 cordis.patch.yml；
 * - 模型选项的取值是 **JSON 数组字符串** `["<provider>","<model>"]`；推理强度只接受模型声明过的档位；
 * - 审批：基础 patch 读 `DSH_PERMISSION_MODE`，`danger-full-access` 时 approval=never；
 * - 没凭据：initialize、session/new 都成功，session/prompt 回 -32603 `no API key for provider route …`，进程不挂；
 * - 消息块是整条提交的消息，不是 token 增量；`/compact` 在 ACP 下只是普通文本（没有命令适配器）。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const DSH_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('dsh');

export const DSH_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  nativeFork: false,
  // DSH_PERMISSION_MODE=danger-full-access（approval=never）；万一还来 request_permission 就自动「允许一次」。
  approvals: false,
  clarify: false,
  hostCompression: false,
  // ACP 下 /compact 只是普通文本，DSH 靠自己的自动压缩。
  nativeCompact: false,
  backgroundDelegation: false,
  // initialize 实测 promptCapabilities.image = false。
  images: false,
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

/** 用量：scoped 信代理；global 下 ACP 只给上下文占用（usage_update），不是计费用量——不记，也不估。 */
export const DSH_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

export const DSH_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [/^DEEPSEEK_/, /^DSH_/, /_API_KEY$/];
