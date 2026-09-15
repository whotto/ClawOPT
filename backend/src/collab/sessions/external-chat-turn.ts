/**
 * 单聊 × 外部编码运行时的一轮：把会话里的外部运行时配置翻成适配器请求，交给运行协调器。
 *
 * 会话行上的四个字段（见 `SessionRow`）：
 * - `external_runtime`：哪个运行时（与 `group_members.runtime` 同一套 id）；
 * - `external_config`：`{ mode: global|scoped, model, reasoningEffort, workingDir }`（不含凭据；scoped 的 model 是
 *   ClawOPT 模型配置里的 `<端点>/<模型>`，上游 key 由 bootstrap 注入的解析器在服务端取，只进代理内存）；
 * - `external_session_id` + `external_session_resumable`：续话句柄与「上一轮成功、可以续」。
 *
 * 规矩与群聊外部成员一致：只有成功才标可续；续话失败换一个新句柄（不拿着死会话一直失败）。
 * `/compact`、`/status`、`/usage` 作为会话命令交给运行时（结果走 `session.command` → 结构化 system 消息）。
 */
import { randomUUID } from 'crypto';
import type express from 'express';

import type { ConfigManager } from '../../core/config';
import type { DB, SessionRow } from '../../core/db';
import type { RealtimeHub } from '../../core/realtime';
import type { AdapterRunOutcome, AgentRuntimeAdapter, RunCoordinator, RunSubmission, RuntimeRunRequest } from '../../runtime';
import { createStructuredChatError } from './chat-messages';
import { chatSessionTopic, type ChatStreamSink, streamNewChatRunToSse } from './chat-stream';
import { ChatTurnRows } from './chat-turn-rows';
import { createExternalChatProjection } from './external-chat-projection';
import type { SessionOrgStore } from './session-org-store';
import { withSessionTitle } from './session-title';
import { type TaskPlanStore, withTaskPlans } from './task-plans';
import { bindUploadedAttachments } from './chat-attachments';

export type ExternalSessionMode = 'global' | 'scoped';

export interface ExternalSessionConfig {
  mode: ExternalSessionMode;
  model?: string;
  reasoningEffort?: string;
  workingDir?: string;
  /**
   * 显式放行的工具（Claude Code `--allowedTools` 的写法，例如 `Write`、`Edit`、`Bash(git status:*)`），与群成员配置同一个键。
   * headless 下会弹权限的工具一律拒绝，不放行就改不了文件；这是逐项白名单，不是 `--dangerously-skip-permissions`。
   */
  allowedTools?: string[];
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ALLOWED_TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\([^()\n\r]{1,200}\))?$/;
export const EXTERNAL_SESSION_MAX_ALLOWED_TOOLS = 50;

/** 工具白名单：只收 `名字` 或 `名字(规则)` 形状的字符串（不收空白分隔的多项、换行、嵌套括号），去重，最多 50 项。 */
function parseAllowedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools = [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => ALLOWED_TOOL_PATTERN.test(item)))]
    .slice(0, EXTERNAL_SESSION_MAX_ALLOWED_TOOLS);
  return tools.length ? tools : undefined;
}

/** 读会话上的外部运行时配置；坏 JSON 按默认（global）处理，不让这个会话彻底不能用。 */
export function parseExternalSessionConfig(raw: string | null | undefined): ExternalSessionConfig {
  let value: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch {
    value = {};
  }
  const text = (key: string) => (typeof value[key] === 'string' && (value[key] as string).trim() ? (value[key] as string).trim() : undefined);
  const effort = text('reasoningEffort');
  return {
    mode: value.mode === 'scoped' ? 'scoped' : 'global',
    model: text('model'),
    reasoningEffort: effort && EFFORTS.has(effort) ? effort : undefined,
    workingDir: text('workingDir'),
    allowedTools: parseAllowedTools(value.allowedTools),
  };
}

/** 写入会话前的清洗：只留认识的键（凭据类键一个都不收）。 */
export function normalizeExternalSessionConfig(input: unknown): string {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const parsed = parseExternalSessionConfig(JSON.stringify(source));
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)));
}

export const EXTERNAL_CHAT_COMMANDS: Record<string, 'compact' | 'status' | 'usage'> = {
  '/compact': 'compact',
  '/status': 'status',
  '/usage': 'usage',
  '/context': 'usage',
};

export function parseExternalChatCommand(message: string): RuntimeRunRequest['command'] | null {
  const trimmed = message.trim();
  const [token = ''] = trimmed.split(/\s+/, 1);
  const kind = EXTERNAL_CHAT_COMMANDS[token.toLowerCase()];
  if (!kind) return null;
  if (kind === 'compact') {
    const instructions = trimmed.slice(token.length).trim();
    return instructions ? { kind, instructions } : { kind };
  }
  return { kind };
}

export function externalModelTag(session: SessionRow): string {
  const config = parseExternalSessionConfig(session.external_config);
  return config.model ? `${session.external_runtime}:${config.model}` : String(session.external_runtime);
}

export type ExternalChatTurnDeps = {
  db: Pick<DB, 'updateMessage' | 'updateMessageEnvelope' | 'deleteMessage' | 'setChatMessagesRunMarker' | 'getSession' | 'saveSession'> & Partial<Pick<DB, 'getFilesBySession'>>;
  /** 这个会话允许的上传根（附件重绑时校验真实路径在它们下面）；不给就不重绑附件。 */
  uploadsRoots?: (session: SessionRow) => string[];
  configManager: Pick<ConfigManager, 'getConfig'>;
  realtime: RealtimeHub;
  runCoordinator: RunCoordinator;
  createAdapter: (runtime: string) => AgentRuntimeAdapter<RuntimeRunRequest> | null;
  defaultWorkspace: (sessionId: string) => string;
  /** 任务计划卡（运行时发的计划 / TodoWrite / update_plan）；不给就不跟踪。 */
  taskPlans?: TaskPlanStore;
  /** 运行时提议的会话标题（`session.title`）按标题优先级落库并推 `session.title.updated`；不给就不收。 */
  sessionTitles?: Pick<SessionOrgStore, 'proposeTitle' | 'getMeta'>;
  /** 这个会话是从哪个单聊分叉出来的（没有返回 null）。 */
  forkSource?: (sessionId: string) => string | null;
};

export type ExternalChatSubmissionResult =
  | { ok: true; submission: RunSubmission<RuntimeRunRequest>; command: RuntimeRunRequest['command'] }
  | { ok: false; error: ReturnType<typeof createStructuredChatError>; modelTag: string };

/**
 * 外部运行时单聊一轮的提交（立即开始与排队共用）。
 *
 * **续话句柄在开始那一刻才读**（`beforeStart` 回 request）：排在上一轮后面的消息，要等上一轮成功才知道能不能续；
 * 入队时读的话，排队的那一条永远拿着「不可续」开一个新的原生会话。上一轮的结局在 `onFinished` 里同步写回，
 * 早于出队。
 */
export function buildExternalChatSubmission(deps: ExternalChatTurnDeps, turn: {
  session: SessionRow;
  prompt: string;
  agentName: string;
  rows: ChatTurnRows;
  origin?: string;
  ref?: string | null;
  /** 排队的一轮：出队时落行（填 rows），返回要并进 meta 的字段。立即开始的一轮不传（行已落好）。 */
  persistRows?: () => void;
}): ExternalChatSubmissionResult {
  const { session, rows } = turn;
  const runtime = String(session.external_runtime);
  const config = parseExternalSessionConfig(session.external_config);
  const modelTag = externalModelTag(session);
  const adapter = deps.createAdapter(runtime);
  if (!adapter) {
    return { ok: false, error: createStructuredChatError(`runtime.unknown: ${runtime}`, 'runtime.unknown'), modelTag };
  }
  const command = parseExternalChatCommand(turn.prompt) ?? undefined;
  const workspace = config.workingDir || deps.defaultWorkspace(session.id);

  // 分叉出来的会话：第一轮从父会话的原生会话分叉（适配器按能力决定怎么做）。
  const forkParent = deps.forkSource?.(session.id) ?? null;
  // 附件：只认这个会话登记过的上传，换成真实本地路径（图片按运行时能力内联），见 chat-attachments.ts。
  const binding = deps.uploadsRoots && deps.db.getFilesBySession
    ? bindUploadedAttachments({
      prompt: turn.prompt,
      sessionFiles: deps.db.getFilesBySession(session.id),
      uploadsRoots: deps.uploadsRoots(session),
      imagesSupported: adapter.capabilities.images,
    })
    : { prompt: turn.prompt, images: [], attachments: [] };
  const buildRequest = (): RuntimeRunRequest => {
    const latest = deps.db.getSession(session.id) ?? session;
    // 句柄缺了（老会话、手工改库）就补一个；续不续由「上一轮成功」决定，适配器还会再过一遍兼容性判定。
    let handle = latest.external_session_id;
    if (!handle) {
      handle = randomUUID();
      deps.db.saveSession({ ...latest, external_session_id: handle, external_session_resumable: 0 });
    }
    return {
      mode: config.mode,
      prompt: command ? turn.prompt : binding.prompt,
      ...(command || binding.images.length === 0 ? {} : { images: binding.images }),
      workspace,
      owner: { kind: 'session', sessionId: session.id },
      sessionId: handle,
      resume: Boolean(latest.external_session_resumable),
      model: config.mode === 'global' ? config.model : undefined,
      reasoningEffort: config.reasoningEffort,
      ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      runtimeConfig: { ...config },
      command,
      ...(forkParent ? { forkFrom: { kind: 'session' as const, sessionId: forkParent } } : {}),
    };
  };

  const submission: RunSubmission<RuntimeRunRequest> = {
    sessionKey: session.id,
    surface: 'chat',
    topics: [chatSessionTopic(session.id), `agent:${session.agentId}`],
    agentId: session.agentId,
    title: turn.agentName,
    adapter,
    // 占位：真正的请求在 beforeStart 里按开始时刻的句柄生成。
    request: { mode: config.mode, prompt: turn.prompt, workspace, owner: { kind: 'session', sessionId: session.id }, sessionId: '', resume: false, command },
    proxyMode: config.mode,
    ref: turn.ref ?? null,
    display: turn.prompt,
    beforeStart: () => {
      turn.persistRows?.();
      return {
        request: buildRequest(),
        meta: { messageId: rows.assistantMessageId, userMessageId: rows.userMessageId, agentId: session.agentId, kind: 'external-run', runtime },
      };
    },
    projector: (run) => {
      const projector = createExternalChatProjection({
        db: deps.db,
        configManager: deps.configManager,
        run,
        messageId: rows.assistantMessageId,
        runMarkerMessageIds: rows.runMarkerMessageIds,
        agentId: session.agentId,
        agentName: turn.agentName,
        modelUsed: modelTag,
        command: command?.kind === 'turn' ? undefined : command?.kind,
      });
      const planned = deps.taskPlans ? withTaskPlans(deps.taskPlans, run, () => rows.assistantMessageId, projector) : projector;
      return deps.sessionTitles ? withSessionTitle(deps.sessionTitles, run, planned) : planned;
    },
    onFinished: (outcome: AdapterRunOutcome) => {
      const latest = deps.db.getSession(session.id);
      if (!latest) return;
      if (outcome.kind === 'completed') {
        if (!latest.external_session_resumable) deps.db.saveSession({ ...latest, external_session_resumable: 1 });
      } else if (outcome.kind === 'failed' && !command) {
        // 失败（含续话失败）：换一个新句柄，下一轮重新开始——不拿着一个续不上的原生会话每轮都失败。
        // 会话命令（/usage /status /compact）失败不算：命令不支持不代表原生会话坏了，丢掉句柄会让之前的对话全部失忆。
        deps.db.saveSession({ ...latest, external_session_id: randomUUID(), external_session_resumable: 0 });
      }
    },
    origin: turn.origin,
    workspacePath: workspace,
    meta: { messageId: rows.assistantMessageId, agentId: session.agentId, kind: 'external-run', runtime },
  };
  return { ok: true, submission, command };
}

/** 立即开始的一轮（行已落好）：SSE 模式先挂上流再提交，等它结束。 */
export async function runExternalChatTurn(deps: ExternalChatTurnDeps, turn: {
  session: SessionRow;
  transport: 'sse' | 'ws';
  origin?: string;
  res: express.Response;
  sink: ChatStreamSink;
  prompt: string;
  assistantMessageId: number;
  userMessageId?: number | null;
  runMarkerMessageIds: number[];
  agentName: string;
  ref?: string | null;
}): Promise<void> {
  const { session, assistantMessageId, sink } = turn;
  const rows = ChatTurnRows.of({ userMessageId: turn.userMessageId ?? null, assistantMessageId, runMarkerMessageIds: turn.runMarkerMessageIds });
  const built = buildExternalChatSubmission(deps, { session, prompt: turn.prompt, agentName: turn.agentName, rows, origin: turn.origin, ref: turn.ref });
  if (!built.ok) {
    const { error, modelTag } = built;
    deps.db.updateMessage(assistantMessageId, error.content, modelTag, null, false);
    deps.db.updateMessageEnvelope(assistantMessageId, error.role, error.agent_id, error.agent_name);
    sink.frame({ type: 'error', text: error.content, messageCode: error.messageCode, rawDetail: error.rawDetail, role: error.role });
    sink.end();
    return;
  }

  if (turn.transport === 'sse') {
    const attachedFrame = { type: 'attached', messageId: assistantMessageId, agentId: session.agentId, agentName: turn.agentName, modelUsed: externalModelTag(session) };
    streamNewChatRunToSse({ realtime: deps.realtime, runCoordinator: deps.runCoordinator }, { sessionId: session.id, messageId: assistantMessageId, attachedFrame, res: turn.res });
  }

  const submitted = await deps.runCoordinator.submit(built.submission, 'replace');
  if (submitted.status !== 'started' && submitted.status !== 'queued') return;
  await submitted.completion;
}
