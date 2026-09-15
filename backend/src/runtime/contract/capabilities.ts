/**
 * 运行时能力声明。
 *
 * 界面与协调器**按声明**决定显示什么、允许什么，不按运行时的名字写 if——
 * 名字分支会在第三个运行时接进来时悄悄漏掉一处，而声明缺一项在类型层就过不去。
 */

/** 本地模型代理的两种接法。scoped：CLI 只拿到代理签发的令牌；global：CLI 用自己的登录。 */
export type ProxyMode = 'scoped' | 'global';

export interface RuntimeCapabilities {
  /** 能在「当前这批工具跑完」的边界上停下（而不是直接杀进程）。 */
  readonly boundaryInterrupt: boolean;
  /** 能用运行时自己的会话 id 续话（Claude Code 的 `--resume`）。 */
  readonly nativeResume: boolean;
  /**
   * 能从一个已确认的原生会话**分叉**出新的原生会话（原会话不动），例如 Claude Code 的 `--resume <id> --fork-session`。
   * 单聊「分叉对话」只对声明了它的运行时显示——拷一份文字记录而运行时并不记得，是假分叉。
   */
  readonly nativeFork: boolean;
  /** 会发出需要人批准的工具调用请求。 */
  readonly approvals: boolean;
  /** 会向人提澄清问题。 */
  readonly clarify: boolean;
  /** 需要宿主（ClawOPT）替它做上下文压缩。 */
  readonly hostCompression: boolean;
  /** 自带压缩命令（如原生 `/compact`）。 */
  readonly nativeCompact: boolean;
  /** 能派出比本轮活得更久的后台子任务。 */
  readonly backgroundDelegation: boolean;
  /** 输入可以带图片。 */
  readonly images: boolean;
  /** 能注入 ClawOPT 托管的 MCP 服务。 */
  readonly mcpInjection: boolean;
  /** 支持的代理接法；空数组表示不经本地代理（OpenClaw 网关自己连模型）。 */
  readonly proxyMode: readonly ProxyMode[];
}

export const CAPABILITY_KEYS = [
  'boundaryInterrupt',
  'nativeResume',
  'nativeFork',
  'approvals',
  'clarify',
  'hostCompression',
  'nativeCompact',
  'backgroundDelegation',
  'images',
  'mcpInjection',
  'proxyMode',
] as const satisfies ReadonlyArray<keyof RuntimeCapabilities>;

/**
 * 声明一个运行时的能力。**每一项都必须显式写出**：漏写一项的对象过不了类型检查，
 * 这正是「新运行时接进来时忘了说自己不支持审批」这类问题该被拦住的地方。
 */
export function defineCapabilities(capabilities: RuntimeCapabilities): Readonly<RuntimeCapabilities> {
  return Object.freeze({ ...capabilities, proxyMode: Object.freeze([...capabilities.proxyMode]) });
}

export function supportsProxyMode(capabilities: RuntimeCapabilities, mode: ProxyMode | undefined): boolean {
  if (!mode) return true;
  return capabilities.proxyMode.includes(mode);
}
