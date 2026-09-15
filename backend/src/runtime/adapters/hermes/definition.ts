/**
 * Hermes Agent（NousResearch/hermes-agent，MIT）作为外部运行时：描述符、能力、事实来源表。
 *
 * 接口选择：**ACP（`hermes acp`）**，依据官方文档 developer-guide/programmatic-integration、user-guide/features/acp、
 * developer-guide/acp-internals 与仓库 acp_adapter/server.py、session.py、permissions.py；对着隔离安装的 0.21.3 实测（2026-09-15）：
 * - 一轮一个 stdio 进程；stdout 只有 JSON-RPC，日志在 stderr；
 * - 真审批：`session/request_permission` 带五个选项（allow_once / allow_session / allow_always / deny / deny_always），60 秒没答按拒绝；
 * - `session/cancel` 约 120 ms 生效，prompt 以 `stopReason: cancelled` 返回；
 * - 跨进程 `session/resume` 能续（resume 期间先把历史当 session/update 重放一遍，再给结果）；
 * - 最终 `PromptResponse.usage` 给出整轮用量；
 * - 没配服务商：`session/new` 回 -32603（`data.details: No LLM provider configured`）；
 * - 上游 401 不走结构化错误：正文里吐一句 `HTTP 401: …`，stopReason 仍是 end_turn；
 * - 没有「CLI 一次性 + JSON 输出」这条路（`hermes -z` 只有纯文本），API server 模式要常驻进程且事件流单消费者——所以不选。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const HERMES_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('hermes');

export const HERMES_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  nativeFork: false,
  approvals: true,
  clarify: false,
  hostCompression: false,
  // `/compress` 作为一轮普通输入发出（Hermes 的斜杠命令）。
  nativeCompact: true,
  backgroundDelegation: false,
  images: true,
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

export const HERMES_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

export const HERMES_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [/^HERMES_/, /_API_KEY$/, /^OPENAI_/, /^ANTHROPIC_/, /^OPENROUTER_/, /^NOUS_/];
