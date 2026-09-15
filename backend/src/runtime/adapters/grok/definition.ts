/**
 * Grok Build CLI（`@xai-official/grok`）：描述符、能力、事实来源表。
 *
 * 对着隔离安装的 `grok` 1.0.30 与官方文档（docs.x.ai/build/cli/headless-scripting、reference、settings）核对（2026-09-15）：
 * - 每轮一个进程：`--output-format streaming-json --prompt-file <文件>`（stdin 不读）；
 * - `-s/--session-id <UUID>` **只能新建**（id 已存在会失败），续话用 `-r/--resume <id>`；
 * - **`--resume <本地不存在的 id>` 会去远端找、进交互式设备码登录并一直挂着**——续话前必须确认本地会话目录存在；
 * - `--always-approve` 绕过审批；`--no-auto-update` 存在但不在 `--help` 里（未知参数会退出码 2，实测接受）；
 * - 没登录：stdout 一行 `{"type":"error","message":"Not signed in…"}`，退出码 1；
 * - `-p "/compact"` 在 headless 下执行内置压缩命令。
 */
import { defineCapabilities, defineSourceOfTruth } from '../../contract';
import { builtinRuntimeDescriptor } from '../../manager/descriptors';
import type { RuntimeDescriptor } from '../../manager/types';

/** 描述符（包名、命令、原生文件表）只在运行时管理器的内置表里写一份。 */
export const GROK_DESCRIPTOR: RuntimeDescriptor = builtinRuntimeDescriptor('grok');

export const GROK_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  // --always-approve：headless 下没有审批通道。
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: true,
  backgroundDelegation: false,
  // --prompt-json 走 argv（图片 base64 会撞 ARG_MAX），prompt 文件只收纯文本：先不开图片。
  images: false,
  // 只在 scoped 模式注入（运行时 home 里的 config.toml）；global 模式不改用户的 ~/.grok/config.toml。
  mcpInjection: true,
  proxyMode: ['global', 'scoped'],
});

export const GROK_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

export const GROK_GLOBAL_CREDENTIAL_ENV: readonly RegExp[] = [/^XAI_/, /^GROK_/];
