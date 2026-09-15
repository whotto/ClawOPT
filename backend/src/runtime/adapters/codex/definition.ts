/**
 * Codex CLI：描述符、能力、事实来源表。
 *
 * 对着本机 `codex-cli` 0.153.4 实测（2026-09-15）：
 * - 新线程 `codex exec --json … --cd <ws> -`，续话 `codex exec resume --json … <threadId> -`（`resume` 子命令**不收** `--cd`，工作目录走进程 cwd）；
 * - prompt 走 stdin（`-`）；线程 id 只能从 `thread.started` 观察到，不能客户端指定；
 * - 压缩走 `codex app-server`（JSON-RPC over stdio：initialize → initialized → thread/resume → thread/compact/start → thread/compacted）；
 * - 审批与沙箱：`--dangerously-bypass-approvals-and-sandbox`（headless 下没有审批通道）+ `--skip-git-repo-check`。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const CODEX_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('codex');

export const CODEX_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  // --dangerously-bypass-approvals-and-sandbox：exec 模式没有可接的审批通道。
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: true,
  backgroundDelegation: false,
  images: true,
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

/**
 * 文本：scoped 下代理的增量更快，但**折进 native 这一路由驱动去重**（见 driver.ts 的 onProxyEvent）——
 * 协调器的去重按 item id 分桶，跨路永远对不上，所以表里只写 native。
 * 工具只信 CLI 的 JSONL（代理那一路的工具事件丢掉）；终态等进程 close；用量 scoped 信代理。
 */
export const CODEX_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

export const CODEX_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [/^OPENAI_/, /^CODEX_/, /^AZURE_OPENAI_/];
