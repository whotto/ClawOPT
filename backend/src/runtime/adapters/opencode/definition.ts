/**
 * OpenCode（`opencode-ai`）：描述符、能力、事实来源表。
 *
 * 对着隔离安装的 `opencode` 1.18.31 与官方仓库 anomalyco/opencode@v1.18.31（docs 与 run.ts）核对（2026-09-15）：
 * - 每轮 `opencode run --format json --auto [--thinking] [-s <会话>] [-m provider/model] [--file <图片>]`；
 * - **prompt 走 stdin**：位置参数里带空格的消息会被加上字面引号（模型收到 `"reply with ok"`），没有位置参数时 stdin 就是整条 prompt；
 * - 没有「客户端指定会话 id」的参数：`sessionID`（`ses_…`）只能从事件里观察；`-s <未知 id>` 报 Session not found、退出码 1；
 * - `--auto` 放行全部权限请求（不带时 run 模式一律拒绝）；
 * - 配置经 `OPENCODE_CONFIG_CONTENT` 注入（最后加载，覆盖用户配置）；没有任何服务商时会回落到内置免费模型并成功——
 *   scoped 必须用 `enabled_providers` 只留我们的服务商；
 * - `/compact` 只在 TUI 里有，run 模式不支持。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const OPENCODE_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('opencode');

export const OPENCODE_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  // --auto + permission {"*": "allow"}：run 模式没有审批通道。
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: false,
  backgroundDelegation: false,
  images: true,
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

export const OPENCODE_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

/** OpenCode 支持的服务商很多，凭据变量没有统一前缀。 */
export const OPENCODE_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [
  /_API_KEY$/, /_AUTH_TOKEN$/, /^OPENCODE_/, /^ANTHROPIC_/, /^OPENAI_/, /^AZURE_/, /^AWS_/, /^GOOGLE_/, /^GITHUB_TOKEN$/,
];
