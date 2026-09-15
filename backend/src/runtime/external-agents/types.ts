/**
 * 外部 Agent 适配层 —— 路线 B 的接口。
 *
 * ## 边界
 *
 * 外部 Agent（Claude Code / Codex / Pi / …）**不写进 `openclaw.json`**。
 * 它们是 ClawOPT 自己的群成员，由这一层适配。v1.5.0 撤回过一次外部 Agent，
 * 错的不是「想接」，是把外部运行时写进了引擎明确忽略的键
 * （whole-agent runtime keys are legacy and ignored），结果「选了 Claude Code 的
 * Agent 回答自己是 DeepSeek，且无任何报错」。
 *
 * ## 为什么把「构造命令」和「执行命令」分开
 *
 * 主机方案还没定（扩容现机 / 跨机调用 / 本机原型），而三种方案下**要跑的命令和
 * 要解析的输出完全相同**，变的只是谁去执行。所以适配器只负责这两件事，
 * 执行器由调用方注入——主机怎么定都不用返工。
 */

export interface ExternalRunRequest {
  /** 会话 UUID，由 ClawOPT 本地生成并与 (group, member) 绑定。 */
  sessionId: string;
  prompt: string;
  /** 子进程的工作目录，决定对方能看到哪些文件与哪份项目指令。 */
  workingDir: string;
  /** 是否续话。实测：不续话时每轮都要重建缓存，成本差 8.8 倍。 */
  resume: boolean;
  model?: string;
  /** 群上下文注进去，但不覆盖对方自己的项目指令。 */
  appendSystemPrompt?: string;
  /** 工具白名单。声明在 ClawOPT，翻译成各家自己的参数。 */
  allowedTools?: string[];
  /** 单次调用的成本硬护栏。 */
  maxBudgetUsd?: number;
  /** 额外允许访问的目录。 */
  extraDirs?: string[];
  /** 执行器的硬超时（毫秒）。不进命令行；缺省用执行器的默认值。工作流节点用它传剩余时限。 */
  timeoutMs?: number;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  cwd: string;
  /**
   * stdin 怎么处理。`devnull` 不是可有可无的细节——实测不重定向时每次固定罚 3 秒
   * （stderr: `no stdin data received in 3s, proceeding without it`）。
   * 群聊里每条消息 3 秒，用户感觉得到。
   */
  stdin: 'devnull' | 'pipe';
  /**
   * `stdin: 'pipe'` 时要喂进去的内容，喂完**立刻关闭**——不关的话子进程会一直
   * 等更多输入。长 prompt 走这条路是为了绕开 `ARG_MAX`（Linux 上 argv + envp
   * 合计通常约 2 MB），撞上它的症状是 `E2BIG`：进程根本起不来，
   * 看起来像「这个成员不说话」。
   */
  stdinData?: string;
}

export type ExternalRunEventKind =
  | 'init'      // 运行时自报家门：模型、版本、工具集 —— 版本漂移探针
  | 'delta'     // 助手正文增量
  | 'progress'  // 工具调用等过程信号，不是正文
  | 'final'     // 本轮结束，带最终文本与成本
  | 'error'
  | 'unknown';  // 认不出的类型。**必须存在这一档**，见下

export interface ExternalRunEvent {
  kind: ExternalRunEventKind;
  text?: string;
  sessionId?: string;
  model?: string;
  runtimeVersion?: string;
  costUsd?: number;
  durationMs?: number;
  detail?: string;
  /** 原始事件，留给日志与排障，**不直接吐给用户**。 */
  raw?: unknown;
}

export interface ExternalAgentAdapter {
  readonly runtime: string;
  buildCommand(request: ExternalRunRequest): BuiltCommand;
  /**
   * 解析一行流式输出。认不出就返回 `kind: 'unknown'`，**不许抛**。
   *
   * 实测（claude 2.1.269）：真实事件流里除文档所列，还有 `system/hook_started`、
   * `system/hook_response`、`rate_limit_event`，而且**随本机 hook 配置而变**。
   * 一个 `switch` 落到 default 就抛的解析器，会在别人的机器上炸。
   */
  parseStreamLine(line: string): ExternalRunEvent | null;
}
