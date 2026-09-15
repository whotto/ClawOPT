import crypto from 'crypto';
import { randomUUID } from 'crypto';
import type {
  AgentRuntimeAdapter,
  RunCoordinator,
  RuntimeRunRequest,
} from '../../runtime';
import fs from 'fs';
import { ConfigReadError, readJsonConfigSafe } from '../../openclaw';
import os from 'os';
import path from 'path';
import type { DB } from '../../core/db';
import type { GroupMemberRow, GroupMessageRow } from '../../core/db';
import { extractOpenClawMessageText, type OpenClawClient } from '../../openclaw';
import {
  type ChatHistorySnapshot,
  extractSettledAssistantOutcome,
  getHistoryTailActivity,
  getHistorySnapshot,
  getUnknownHistorySnapshot,
  isNonTerminalAssistantMessage,
  shouldPreferSettledAssistantText,
} from '../../openclaw';
import { EventEmitter } from 'events';
import {
  AudioPreparationError,
  buildAudioTranscriptContext,
  prepareAudioTranscriptsFromUploads,
} from '../../workspace';
import {
  buildDocumentToolingContext,
  buildManagedDocumentToolingInstruction,
  ensureManagedDocumentToolingReady,
  hasDocumentUploads,
} from '../../workspace';
import {
  buildImageUploadInspectionContext,
  rewriteMessageWithWorkspaceUploads,
  type MessageAttachment,
  type WorkspaceUploadLink,
} from '../../workspace';
import { rewriteVisibleFileLinks } from '../../workspace';
import {
  agentTopic,
  createExternalMemberProjector,
  describeExternalFailure,
  externalMemberSessionKey,
  roomTopic,
} from './external-member-run';
import { ensureGroupWorkspace, getGroupRuntimeSessionKey } from './group-workspace';
import { selectPreferredTextSnapshot } from '../../core/util';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import { shouldUseConfiguredImageGenerationModel } from '../../control';
import type { ExecuteTurnInput, MemberTurnExecutor, MemberTurnResult } from './room-orchestrator';
import { RoomFence, RunWatchdog, type FenceToken } from './room-fence';
import { RELAY_OUTCOME_UNKNOWN_CODE } from './handoff-dispatcher';

const GROUP_STREAM_COMPLETION_PROBE_DELAY_MS = 1200;
const GROUP_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
const GROUP_HISTORY_COMPLETION_PROBE_LIMIT = 60;
const GROUP_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
const GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
const GROUP_FINAL_EVENT_SETTLE_GRACE_MS = 1500;
const GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
const GROUP_HISTORY_ACTIVITY_GRACE_MS = 2 * 60 * 1000;
const MAX_CHAIN_DEPTH_MESSAGE_CODE = 'group.maxChainDepthReached' as const;
const MAX_CHAIN_DEPTH_MESSAGE_REGEX = /^链式转发已达到最大深度 \((\d+) 轮\)$/;
const CHAIN_FORWARDING_DISABLED_MESSAGE_CODE = 'group.chainForwardingDisabled' as const;
const MEMBER_BUSY_MESSAGE_CODE = 'group.memberBusy' as const;

/** 外部成员的 sender_id 前缀：与 OpenClaw 的 agentId 命名空间彻底隔开。 */
export function externalSenderId(runtime: string, agentId: string): string {
  return `ext:${runtime}:${agentId}`;
}

/** `ext:<runtime>:<agentId>` 的逆运算；不是这个形状就返回 null。 */
export function parseExternalSenderId(value: string): { runtime: string; agentId: string } | null {
  if (!value.startsWith('ext:')) return null;
  const rest = value.slice(4);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { runtime: rest.slice(0, sep), agentId: rest.slice(sep + 1) };
}
const CHAIN_FORWARDING_DISABLED_MESSAGE_REGEX = /^链式转发已关闭，未转交给 (.+)$/;
const AGENT_RESPONSE_FAILED_MESSAGE_CODE = 'group.agentResponseFailed' as const;
const AGENT_RESPONSE_FAILED_MESSAGE_REGEX = /^❌\s+(.+?)\s+响应失败:\s*([\s\S]*)$/;
const GROUP_HOST_TAKEOVER_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const GROUP_HOST_TAKEOVER_HOST_ROOT_PATH = path.join(os.homedir(), '.openclaw', 'host-takeover', 'bin', 'host-root');

export interface StructuredGroupMessage {
  messageCode?: string;
  messageParams?: Record<string, string | number | boolean | null>;
  rawDetail?: string;
  forceSystemMessage?: boolean;
}

type ActiveGroupRun = {
  groupId: string;
  agentId: string;
  agentName: string;
  runId: string;
  sessionKey: string;
  client: OpenClawClient;
  startedAt: number;
  messageId: number;
  parentId?: number;
  modelUsed: string;
  createdAt: string;
  rawText: string;
  text: string;
  processContent: string;
  processStreaming: boolean;
};

type PendingGroupRun = {
  groupId: string;
  agentId: string | null;
  agentName: string | null;
  startedAt: number;
  messageId?: number;
  parentId?: number;
  modelUsed?: string;
  createdAt?: string;
  rawText: string;
  text: string;
  processContent: string;
  processStreaming: boolean;
};

type GroupDirectImageGenerationResult = {
  content: string;
  processContent: string;
  modelUsed: string;
  imagePath: string;
};

export type GroupDirectImageGenerationHandler = (params: {
  prompt: string;
  intentText?: string;
  intentContext?: Array<string | null | undefined> | string | null;
  outputDir: string;
}) => Promise<GroupDirectImageGenerationResult | null>;

export type GroupDirectImageGenerationStartProcessBuilder = () => string | null;

type SplitGroupProcessOutputResult = {
  finalContent: string;
  processContent: string;
  processStreaming: boolean;
};

export type GroupToolProgressLocale = 'zh-CN' | 'zh-TW' | 'en';

type GroupToolProgressKind =
  | 'browse'
  | 'command'
  | 'generic'
  | 'open_file'
  | 'search'
  | 'spawn_agent'
  | 'update_file'
  | 'update_plan'
  | 'view_image'
  | 'wait_agent';

export type GroupToolProgressState = {
  toolName: string;
  args?: Record<string, unknown>;
};

const GROUP_TOOL_PROGRESS_MAX_LINES = 80;
const GROUP_TOOL_PROGRESS_MAX_DETAIL_CHARS = 120;

const GROUP_TOOL_PROGRESS_TEXT: Record<GroupToolProgressLocale, Record<string, string>> = {
  'zh-CN': {
    agentFinished: '子任务已返回结果',
    agentStarted: '子任务已启动',
    browseCompleted: '页面操作已完成',
    browsing: '正在打开页面',
    commandCompleted: '命令已完成',
    commandFailed: '命令执行失败',
    executingTool: '正在执行工具',
    fileOpened: '文件读取已完成',
    fileUpdated: '文件修改已完成',
    imageViewed: '图片查看已完成',
    openingFile: '正在打开文件',
    planUpdated: '计划已更新',
    runningCommand: '正在运行命令',
    searchCompleted: '搜索已完成',
    searching: '正在搜索',
    spawningAgent: '正在启动子任务',
    toolCompleted: '工具已完成',
    toolFailed: '工具执行失败',
    updatingFile: '正在修改文件',
    updatingPlan: '正在更新计划',
    viewingImage: '正在查看图片',
    waitingAgent: '正在等待子任务结果',
  },
  'zh-TW': {
    agentFinished: '子任務已返回結果',
    agentStarted: '子任務已啟動',
    browseCompleted: '頁面操作已完成',
    browsing: '正在開啟頁面',
    commandCompleted: '命令已完成',
    commandFailed: '命令執行失敗',
    executingTool: '正在執行工具',
    fileOpened: '檔案讀取已完成',
    fileUpdated: '檔案修改已完成',
    imageViewed: '圖片查看已完成',
    openingFile: '正在開啟檔案',
    planUpdated: '計畫已更新',
    runningCommand: '正在執行命令',
    searchCompleted: '搜尋已完成',
    searching: '正在搜尋',
    spawningAgent: '正在啟動子任務',
    toolCompleted: '工具已完成',
    toolFailed: '工具執行失敗',
    updatingFile: '正在修改檔案',
    updatingPlan: '正在更新計畫',
    viewingImage: '正在查看圖片',
    waitingAgent: '正在等待子任務結果',
  },
  en: {
    agentFinished: 'Subtask returned',
    agentStarted: 'Subtask started',
    browseCompleted: 'Browser action completed',
    browsing: 'Opening page',
    commandCompleted: 'Command completed',
    commandFailed: 'Command failed',
    executingTool: 'Running tool',
    fileOpened: 'File read completed',
    fileUpdated: 'File update completed',
    imageViewed: 'Image inspection completed',
    openingFile: 'Opening file',
    planUpdated: 'Plan updated',
    runningCommand: 'Running command',
    searchCompleted: 'Search completed',
    searching: 'Searching',
    spawningAgent: 'Starting subtask',
    toolCompleted: 'Tool completed',
    toolFailed: 'Tool failed',
    updatingFile: 'Updating file',
    updatingPlan: 'Updating plan',
    viewingImage: 'Inspecting image',
    waitingAgent: 'Waiting for subtask result',
  },
};

class GroupResetInterruptedError extends Error {
  constructor(groupId: string) {
    super(`Group "${groupId}" was reset during processing.`);
    this.name = 'GroupResetInterruptedError';
  }
}

function resolveChatFinalTextSnapshot(text: string, message: any): string {
  if (isNonTerminalAssistantMessage(message)) {
    return '';
  }
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

function escapeRegExpForPrompt(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeGroupPromptText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeGroupToolProgressLocale(value?: string | null): GroupToolProgressLocale {
  return value === 'zh-TW' || value === 'en' ? value : 'zh-CN';
}

function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function truncateGroupToolProgressText(value: string, maxChars = GROUP_TOOL_PROGRESS_MAX_DETAIL_CHARS): string {
  const normalized = stripAnsiCodes(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function normalizeToolArgsRecord(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined;
}

function getNestedToolArgValue(args: Record<string, unknown> | undefined, pathExpression: string): unknown {
  if (!args) return undefined;

  let current: unknown = args;
  for (const segment of pathExpression.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function getFirstToolDetailValue(args: Record<string, unknown> | undefined, paths: string[]): string {
  for (const pathExpression of paths) {
    const value = getNestedToolArgValue(args, pathExpression);
    if (typeof value === 'string' && value.trim()) {
      return truncateGroupToolProgressText(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return '';
}

function resolveToolProgressKind(toolName: string, args?: Record<string, unknown>): GroupToolProgressKind {
  const normalizedName = toolName.trim().toLowerCase();
  const hasPath = !!getFirstToolDetailValue(args, ['path', 'filePath', 'file_path', 'filename']);
  const hasUrl = !!getFirstToolDetailValue(args, ['url', 'urls.0']);

  if (normalizedName === 'exec' || normalizedName === 'exec_command' || normalizedName.includes('shell')) {
    return 'command';
  }
  if (normalizedName === 'apply_patch' || normalizedName === 'edit' || normalizedName === 'write') {
    return 'update_file';
  }
  if (normalizedName === 'update_plan') {
    return 'update_plan';
  }
  if (normalizedName === 'spawn_agent' || normalizedName === 'sessions_spawn' || normalizedName.includes('spawn')) {
    return 'spawn_agent';
  }
  if (normalizedName === 'wait_agent') {
    return 'wait_agent';
  }
  if (normalizedName === 'view_image' || normalizedName === 'image_query') {
    return 'view_image';
  }
  if (normalizedName.includes('search') || normalizedName === 'find') {
    return 'search';
  }
  if (normalizedName === 'read' || normalizedName === 'open' || normalizedName === 'cat') {
    return hasUrl ? 'browse' : 'open_file';
  }
  if (normalizedName === 'click' || normalizedName === 'screenshot' || normalizedName.includes('browser') || normalizedName.includes('web') || hasUrl) {
    return 'browse';
  }
  if (hasPath) {
    return 'open_file';
  }

  return 'generic';
}

function resolveToolProgressDetail(toolName: string, args?: Record<string, unknown>): string {
  const kind = resolveToolProgressKind(toolName, args);

  if (kind === 'command') {
    return getFirstToolDetailValue(args, ['cmd', 'command', 'cwd', 'workdir']);
  }

  if (kind === 'open_file' || kind === 'update_file' || kind === 'view_image') {
    return getFirstToolDetailValue(args, ['path', 'filePath', 'file_path', 'filename', 'ref_id', 'paths.0']);
  }

  if (kind === 'search') {
    return getFirstToolDetailValue(args, ['q', 'query', 'pattern', 'search_query.0.q', 'image_query.0.q', 'location']);
  }

  if (kind === 'browse') {
    return getFirstToolDetailValue(args, ['url', 'ref_id', 'q', 'location']);
  }

  if (kind === 'spawn_agent') {
    return getFirstToolDetailValue(args, ['message', 'task', 'name', 'agent_type', 'target']);
  }

  if (kind === 'wait_agent') {
    return getFirstToolDetailValue(args, ['target', 'targets.0', 'sessionKey']);
  }

  if (kind === 'update_plan') {
    return getFirstToolDetailValue(args, ['explanation', 'plan.0.step']);
  }

  return getFirstToolDetailValue(args, [
    'path',
    'url',
    'q',
    'query',
    'pattern',
    'command',
    'cmd',
    'message',
    'task',
    'name',
    'target',
  ]);
}

function buildToolProgressLine(locale: GroupToolProgressLocale, label: string, detail?: string): string {
  const separator = locale === 'en' ? ': ' : '：';
  const normalizedDetail = detail ? truncateGroupToolProgressText(detail) : '';
  return normalizedDetail ? `- ${label}${separator}${normalizedDetail}` : `- ${label}`;
}

export function formatToolStartProgress(locale: GroupToolProgressLocale, toolName: string, args?: Record<string, unknown>): string {
  const text = GROUP_TOOL_PROGRESS_TEXT[locale];
  const detail = resolveToolProgressDetail(toolName, args);

  switch (resolveToolProgressKind(toolName, args)) {
    case 'command':
      return buildToolProgressLine(locale, text.runningCommand, detail);
    case 'open_file':
      return buildToolProgressLine(locale, text.openingFile, detail);
    case 'update_file':
      return buildToolProgressLine(locale, text.updatingFile, detail);
    case 'search':
      return buildToolProgressLine(locale, text.searching, detail);
    case 'browse':
      return buildToolProgressLine(locale, text.browsing, detail);
    case 'view_image':
      return buildToolProgressLine(locale, text.viewingImage, detail);
    case 'update_plan':
      return buildToolProgressLine(locale, text.updatingPlan, detail);
    case 'spawn_agent':
      return buildToolProgressLine(locale, text.spawningAgent, detail);
    case 'wait_agent':
      return buildToolProgressLine(locale, text.waitingAgent, detail);
    default:
      return buildToolProgressLine(locale, `${text.executingTool} ${toolName}`.trim(), detail);
  }
}

export function formatToolResultProgress(locale: GroupToolProgressLocale, toolName: string, args: Record<string, unknown> | undefined, isError: boolean): string {
  const text = GROUP_TOOL_PROGRESS_TEXT[locale];
  const detail = resolveToolProgressDetail(toolName, args);

  if (isError) {
    if (resolveToolProgressKind(toolName, args) === 'command') {
      return buildToolProgressLine(locale, text.commandFailed, detail);
    }
    return buildToolProgressLine(locale, text.toolFailed, detail || toolName);
  }

  switch (resolveToolProgressKind(toolName, args)) {
    case 'command':
      return buildToolProgressLine(locale, text.commandCompleted, detail);
    case 'open_file':
      return buildToolProgressLine(locale, text.fileOpened, detail);
    case 'update_file':
      return buildToolProgressLine(locale, text.fileUpdated, detail);
    case 'search':
      return buildToolProgressLine(locale, text.searchCompleted, detail);
    case 'browse':
      return buildToolProgressLine(locale, text.browseCompleted, detail);
    case 'view_image':
      return buildToolProgressLine(locale, text.imageViewed, detail);
    case 'update_plan':
      return buildToolProgressLine(locale, text.planUpdated, detail);
    case 'spawn_agent':
      return buildToolProgressLine(locale, text.agentStarted, detail);
    case 'wait_agent':
      return buildToolProgressLine(locale, text.agentFinished, detail);
    default:
      return buildToolProgressLine(locale, text.toolCompleted, detail || toolName);
  }
}

export function appendToolProgressLine(lines: string[], line: string): boolean {
  const normalizedLine = line.trim();
  if (!normalizedLine) return false;
  if (lines[lines.length - 1] === normalizedLine) {
    return false;
  }

  lines.push(normalizedLine);
  if (lines.length > GROUP_TOOL_PROGRESS_MAX_LINES) {
    lines.splice(0, lines.length - GROUP_TOOL_PROGRESS_MAX_LINES);
  }
  return true;
}

function resolveConfiguredProcessTagPair(
  primaryStartTag?: string | null,
  primaryEndTag?: string | null,
  secondaryStartTag?: string | null,
  secondaryEndTag?: string | null,
): { startTag?: string; endTag?: string } {
  const normalize = (value?: string | null) => (typeof value === 'string' ? value.trim() : '');
  const primaryStart = normalize(primaryStartTag);
  const primaryEnd = normalize(primaryEndTag);
  if (primaryStart && primaryEnd) {
    return { startTag: primaryStart, endTag: primaryEnd };
  }

  const secondaryStart = normalize(secondaryStartTag);
  const secondaryEnd = normalize(secondaryEndTag);
  if (secondaryStart && secondaryEnd) {
    return { startTag: secondaryStart, endTag: secondaryEnd };
  }

  return {};
}

function findTrailingIncompleteConfiguredTagFragment(content: string, tag?: string): string {
  const normalizedTag = tag?.trim() || '';
  if (!content || !normalizedTag || content.endsWith(normalizedTag)) {
    return '';
  }

  const minFragmentLength = Math.min(3, Math.max(1, normalizedTag.length - 1));
  const maxFragmentLength = Math.min(content.length, normalizedTag.length - 1);

  for (let length = maxFragmentLength; length >= minFragmentLength; length -= 1) {
    const fragment = normalizedTag.slice(0, length);
    if (content.endsWith(fragment)) {
      return fragment;
    }
  }

  return '';
}

function stripConfiguredProcessTagArtifacts(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): string {
  if (!content) return content;

  const tags = [processStartTag?.trim(), processEndTag?.trim()]
    .filter((tag): tag is string => Boolean(tag));
  if (tags.length === 0) {
    return content.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  let cleanedContent = content.replace(/\r\n?/g, '\n');

  for (const tag of tags) {
    cleanedContent = cleanedContent.replace(new RegExp(escapeRegExpForPrompt(tag), 'g'), '');
  }

  cleanedContent = cleanedContent
    .split('\n')
    .map((line) => {
      let nextLine = line;

      while (true) {
        const startFragment = findTrailingIncompleteConfiguredTagFragment(nextLine, processStartTag);
        const endFragment = findTrailingIncompleteConfiguredTagFragment(nextLine, processEndTag);
        const fragment = startFragment.length >= endFragment.length ? startFragment : endFragment;

        if (!fragment) {
          return nextLine;
        }

        nextLine = nextLine
          .slice(0, nextLine.length - fragment.length)
          .replace(/[ \t]+$/g, '');
      }
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleanedContent;
}

function splitGroupProcessOutput(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
): SplitGroupProcessOutputResult {
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();

  const cleanup = (value: string) => (
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );

  if (!normalizedContent || !startTag || !endTag) {
    return {
      finalContent: stripConfiguredProcessTagArtifacts(cleanup(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const startPattern = escapeRegExpForPrompt(startTag);
  const endPattern = escapeRegExpForPrompt(endTag);
  const processRegex = new RegExp(`${startPattern}([\\s\\S]*?)(?:${endPattern}|$)`, 'g');
  const processBlocks: string[] = [];
  let processStreaming = false;
  let match: RegExpExecArray | null;

  while ((match = processRegex.exec(normalizedContent)) !== null) {
    processBlocks.push(match[1] || '');
    if (!match[0].endsWith(endTag)) {
      processStreaming = true;
    }
  }

  if (processBlocks.length === 0) {
    return {
      finalContent: stripConfiguredProcessTagArtifacts(cleanup(normalizedContent), processStartTag, processEndTag),
      processContent: '',
      processStreaming: false,
    };
  }

  const processContent = stripConfiguredProcessTagArtifacts(
    cleanup(processBlocks.join('\n\n')),
    processStartTag,
    processEndTag,
  );
  const finalContent = stripConfiguredProcessTagArtifacts(
    cleanup(
      normalizedContent
        .replace(processRegex, '\n\n')
        .replace(new RegExp(`(?:${startPattern}|${endPattern})`, 'g'), '\n\n'),
    ),
    processStartTag,
    processEndTag,
  );

  return {
    finalContent,
    processContent,
    processStreaming,
  };
}

function combineGroupProcessContent(toolContent: string, modelContent: string): string {
  return [toolContent, modelContent]
    .map((value) => normalizeGroupPromptText(value || ''))
    .filter(Boolean)
    .join('\n\n');
}

function isGroupHostTakeoverEnabled(): boolean {
  try {
    // 走网关：同样是大写变量名躲过了守卫。本 sprint 不碰群聊的执行逻辑，
    // 但「读配置」这条判据不该在这个文件里有第二份实现。
    const read = readJsonConfigSafe(GROUP_HOST_TAKEOVER_CONFIG_PATH);
    const config: any = read.exists ? read.value : {};
    return !config?.tools?.profile && config?.tools?.exec?.security === 'full';
  } catch (error) {
    // 「配置读不动」与「这台机器没开 host takeover」是两件事，返回值都是 false，
    // 但只有后者是用户的选择。静默地把前者当成后者，用户会看到一个功能忽然不见了、
    // 而日志里一点痕迹都没有——红线 C 正是防这个。
    // 返回 false 是对的（失败朝着关闭的方向），但**不能不出声**。
    const reason = error instanceof ConfigReadError ? `${error.reason}：${error.detail}` : String(error);
    console.warn(`[GroupChat] 读取 host takeover 配置失败（${reason}），本次按关闭处理`);
    return false;
  }
}

function buildGroupHostTakeoverPrompt(): string {
  const currentUser = (process.env.USER || 'user').trim() || 'user';
  return [
    '【Host takeover】',
    'Maximum permissions are enabled. You can directly operate this Linux host and use root when required.',
    'Treat installed host tools as part of your execution environment: if a command-line tool exists on this machine, you should discover it from PATH and use it directly instead of claiming the product lacks that capability.',
    'For uploaded files or workspace files, use their absolute paths. When the model cannot natively understand a file type, first call the appropriate local tool to inspect, transcribe, convert, extract, or summarize it, then continue the task.',
    buildManagedDocumentToolingInstruction(),
    `Immediate root entrypoint: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH}`,
    `Run a complex root shell with: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH} /bin/sh -lc '<command>'`,
    `To drop back to the normal user, run: ${GROUP_HOST_TAKEOVER_HOST_ROOT_PATH} --as-user ${currentUser} -- <command>`,
    'After the OpenClaw gateway restarts, common commands such as sudo, apt, apt-get, pip, python -m pip, systemctl, journalctl, mount, umount, chmod, chown, and tee will also flow through the takeover wrappers automatically.',
  ].join('\n');
}

/**
 * 成员正忙。改成每成员一把锁之后，这条取代了原来那个「整群 409」的沉默行为——
 * 用户得看见是**谁**在忙，而不是整个群没反应。
 */
function createMemberBusyMessage(agentName: string): Required<StructuredGroupMessage> & { content: string } {
  return {
    content: `${agentName} 正在处理上一条消息，本次未转交`,
    messageCode: MEMBER_BUSY_MESSAGE_CODE,
    messageParams: { agentName },
    rawDetail: '',
    forceSystemMessage: true,
  };
}

export function createAgentResponseFailedMessage(agentName: string, rawDetail?: string | null): Required<StructuredGroupMessage> & { content: string } {
  const detail = (rawDetail || '').trim();
  return {
    content: `❌ ${agentName} 响应失败: ${detail || 'Unknown error'}`,
    messageCode: AGENT_RESPONSE_FAILED_MESSAGE_CODE,
    messageParams: { agentName },
    rawDetail: detail,
    forceSystemMessage: true,
  };
}

export function getStructuredGroupMessage(content?: string | null): StructuredGroupMessage {
  if (!content) return {};

  const chainDisabledMatch = content.match(CHAIN_FORWARDING_DISABLED_MESSAGE_REGEX);
  if (chainDisabledMatch) {
    return {
      messageCode: CHAIN_FORWARDING_DISABLED_MESSAGE_CODE,
      messageParams: { agentName: chainDisabledMatch[1] },
      rawDetail: '',
      forceSystemMessage: true,
    };
  }

  const maxDepthMatch = content.match(MAX_CHAIN_DEPTH_MESSAGE_REGEX);
  if (maxDepthMatch) {
    const maxDepth = Number(maxDepthMatch[1]);
    if (Number.isFinite(maxDepth)) {
      return {
        messageCode: MAX_CHAIN_DEPTH_MESSAGE_CODE,
        messageParams: { maxDepth },
        rawDetail: '',
        forceSystemMessage: true,
      };
    }
  }

  const agentResponseFailedMatch = content.match(AGENT_RESPONSE_FAILED_MESSAGE_REGEX);
  if (agentResponseFailedMatch) {
    const agentName = agentResponseFailedMatch[1]?.trim();
    const rawDetail = agentResponseFailedMatch[2]?.trim() || '';
    if (agentName) {
      return {
        messageCode: AGENT_RESPONSE_FAILED_MESSAGE_CODE,
        messageParams: { agentName },
        rawDetail,
        forceSystemMessage: true,
      };
    }
  }

  return {};
}

/**
 * 群里一个成员执行一跳（P3 起）。
 *
 * **引擎只负责「执行一跳」**：谁接、按什么顺序、能不能继续转交、深度、发起人授权都在编排器（`room-orchestrator.ts`）；
 * prompt 由协作层按 v2 上下文构建（`room-prompt.ts`，经 `useRoomTurnHooks` 注入）。
 * 一跳结束只返回结果，不再在这里递归转交。
 *
 * 两条执行路径彼此独立：
 * - OpenClaw 网关路径（`runGatewayMember`）：整套会话对账、文本快照保护、工具进度 i18n，全是从事故里长出来的；
 *   网关运行的跟踪状态按群键（一个群同时一次网关运行），所以同群的网关成员经 `gatewayTurnChains` 串行；
 * - 外部运行时路径（`runExternalMember`，含远程 Agent）：经运行协调器，同群不同成员并发。
 */
export type PromptEnvironment = {
  workspace: { root: string; uploads: string | null; output: string | null } | null;
  processTags: { startTag: string; endTag: string } | null;
  hostTakeoverPrompt: string | null;
  /** 交给接收方的触发正文（网关路径已并入附件检视 / 文档工具 / 转写语境）。 */
  triggerText: string;
  /** 历史里的上传链接 → 工作区路径（网关路径）。 */
  rewriteContent?: (text: string) => string;
};

/** 一跳的运行作用域：远程工作区令牌、工作区检查点。`finish` 在运行结束、算 diff 之前吊销令牌并等进行中的写入排空。 */
export type RoomRunScope = {
  remoteWorkspaceApi: { baseUrl: string; token: string } | null;
  runtimeConfig: Record<string, unknown>;
  finish(result: { messageId: number | null; status: MemberTurnResult['status']; runMarker: string | null }): Promise<void>;
};

export type RoomTurnHooks = {
  buildPrompt(input: ExecuteTurnInput, env: PromptEnvironment, scope: RoomRunScope): string;
  beginRun(input: ExecuteTurnInput, workspacePath: string | null): Promise<RoomRunScope>;
};

const NOOP_SCOPE: RoomRunScope = { remoteWorkspaceApi: null, runtimeConfig: {}, finish: async () => {} };

type TurnContext = {
  input: ExecuteTurnInput;
  parentId: number | undefined;
  fence: FenceToken;
  idleMs: number;
  totalMs: number;
  scope: RoomRunScope;
};

export class GroupChatEngine extends EventEmitter implements MemberTurnExecutor {
  private db: DB;
  private getClient: (sessionId: string) => Promise<OpenClawClient>;
  private getAgentModel: (agentId: string) => string;
  private getPreferredLanguage: () => GroupToolProgressLocale;
  /** 房间代数 + 成员中断版本（会话隔离）。清空 / 删除 / 停止推进房间代数，中断单个成员推进它的版本。 */
  readonly fence = new RoomFence();
  private prepareGroupRuntime: (groupId: string, agentId: string) => Promise<{
      runtimeAgentId: string;
      workspacePath: string;
      uploadsPath: string;
      outputPath: string;
      bootstrapContext?: string;
  }>;
  private canUseHostTakeover: (agentId: string) => boolean;
  private tryGenerateImageForPrompt?: GroupDirectImageGenerationHandler;
  private buildImageGenerationStartProcessContent?: GroupDirectImageGenerationStartProcessBuilder;
  private pendingRuns = new Map<string, PendingGroupRun>();
  private activeRuns = new Map<string, ActiveGroupRun>();
  /** 同群的网关成员串行（网关运行的跟踪状态按群键，见类注释）。 */
  private gatewayTurnChains = new Map<string, Promise<unknown>>();
  /** 外部成员的运行由协调器驱动（room-engine.ts 组装时注入）。 */
  private runCoordinator: RunCoordinator | null = null;

  useRunCoordinator(coordinator: RunCoordinator): void {
    this.runCoordinator = coordinator;
  }

  /**
   * 外部成员按 `member.runtime` 从适配器登记处取适配器（Claude Code / Codex / Pi / Grok / OpenCode / DSH / Hermes /
   * 远程 OpenClaw / 远程 Agent relay）。bootstrap 注入；没注入或登记处里没有 → 返回 null，调用方写明失败。
   */
  private runtimeAdapters: ((runtime: string) => AgentRuntimeAdapter<RuntimeRunRequest> | null) | null = null;

  useRuntimeAdapters(lookup: (runtime: string) => AgentRuntimeAdapter<RuntimeRunRequest> | null): void {
    this.runtimeAdapters = lookup;
  }

  private turnHooks: RoomTurnHooks | null = null;

  /** 协作层（prompt v2 构建、远程工作区令牌、工作区检查点）。 */
  useRoomTurnHooks(hooks: RoomTurnHooks): void {
    this.turnHooks = hooks;
  }

  private requireTurnHooks(): RoomTurnHooks {
    if (!this.turnHooks) throw new Error('GroupChatEngine: room turn hooks are not attached');
    return this.turnHooks;
  }

  private requireRunCoordinator(): RunCoordinator {
    if (!this.runCoordinator) throw new Error('GroupChatEngine: run coordinator is not attached');
    return this.runCoordinator;
  }

  constructor(
    db: DB,
    getClient: (sessionId: string) => Promise<OpenClawClient>,
    getAgentModel: (agentId: string) => string,
    getPreferredLanguage: () => GroupToolProgressLocale,
    prepareGroupRuntime: (groupId: string, agentId: string) => Promise<{
      runtimeAgentId: string;
      workspacePath: string;
      uploadsPath: string;
      outputPath: string;
      bootstrapContext?: string;
    }>,
    tryGenerateImageForPrompt?: GroupDirectImageGenerationHandler,
    buildImageGenerationStartProcessContent?: GroupDirectImageGenerationStartProcessBuilder,
    canUseHostTakeover?: (agentId: string) => boolean,
  ) {
    super();
    this.db = db;
    this.getClient = getClient;
    this.getAgentModel = getAgentModel;
    this.getPreferredLanguage = getPreferredLanguage;
    this.prepareGroupRuntime = prepareGroupRuntime;
    this.tryGenerateImageForPrompt = tryGenerateImageForPrompt;
    this.buildImageGenerationStartProcessContent = buildImageGenerationStartProcessContent;
    this.canUseHostTakeover = canUseHostTakeover || (() => isGroupHostTakeoverEnabled());
  }

  /**
   * 每成员一把锁，键是 (群, 成员)。
   *
   * P3 起执行顺序由编排器的每 Agent 队列保证（同一个成员同一时刻只有一个 worker），
   * 这把锁留作兜底：绕开队列的路径、陈旧 worker 接管时仍然不会让同一个成员并发两轮。
   * 陈旧阈值 15 分钟：外部子进程跑飞时，成员不能永远锁死。
   */
  private processingMembers = new Map<string, number>();

  /**
   * 锁键。**带长度前缀**，不是简单拼接——`${groupId}::${agentId}` 会让
   * ('g1::a', 'b') 与 ('g1', 'a::b') 落到同一把锁上，两个不同成员互相顶掉。
   * 群 id 与 Agent id 都可能来自用户输入，不能假设它们不含分隔符。
   */
  memberLockKey(groupId: string, agentId: string): string {
    return `${groupId.length}:${groupId}:${agentId}`;
  }

  private isMemberLockStale(key: string): boolean {
    const since = this.processingMembers.get(key);
    if (!since) return false;
    return Date.now() - since > GroupChatEngine.STALE_LOCK_MS;
  }

  /** 拿到锁返回 true；已被占用且未陈旧返回 false。 */
  acquireMemberLock(groupId: string, agentId: string): boolean {
    const key = this.memberLockKey(groupId, agentId);
    if (this.processingMembers.has(key)) {
      if (!this.isMemberLockStale(key)) return false;
      const minutes = Math.floor((Date.now() - (this.processingMembers.get(key) ?? 0)) / 60000);
      console.warn(`[GroupChat] 成员 ${agentId}（群 ${groupId}）的运行锁已持有 ${minutes} 分钟，判定为卡死并允许接管`);
    }
    this.processingMembers.set(key, Date.now());
    return true;
  }

  releaseMemberLock(groupId: string, agentId: string): void {
    this.processingMembers.delete(this.memberLockKey(groupId, agentId));
  }

  /** 当前持有的成员锁快照。只给诊断用——锁泄漏在界面上是看不见的。 */
  heldMemberLockSnapshot(): Array<{ groupId: string; agentId: string; heldMs: number }> {
    const now = Date.now();
    const out: Array<{ groupId: string; agentId: string; heldMs: number }> = [];
    for (const [key, since] of this.processingMembers) {
      // 键是 `${groupId.length}:${groupId}:${agentId}`，按长度前缀切回去。
      const firstColon = key.indexOf(':');
      const len = Number(key.slice(0, firstColon));
      const groupId = key.slice(firstColon + 1, firstColon + 1 + len);
      const agentId = key.slice(firstColon + 2 + len);
      out.push({ groupId, agentId, heldMs: now - since });
    }
    return out;
  }

  /** 这个群里还有没有成员在跑。运行态展示与「群忙不忙」都看它。 */
  hasBusyMember(groupId: string): boolean {
    const prefix = `${groupId.length}:${groupId}:`;
    for (const key of this.processingMembers.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** 这个成员是不是正在跑（重新生成它的回复前要看）。 */
  isMemberBusy(groupId: string, agentId: string): boolean {
    const key = this.memberLockKey(groupId, agentId);
    return this.processingMembers.has(key) && !this.isMemberLockStale(key);
  }

  /** 群里跑得最久的那个成员已经跑了多久（分钟）；没有在跑的返回 null。给 409 提示一个能判断的数字。 */
  longestMemberRunMinutes(groupId: string): number | null {
    const held = this.heldMemberLockSnapshot().filter((item) => item.groupId === groupId);
    if (held.length === 0) return null;
    return Math.floor(Math.max(...held.map((item) => item.heldMs)) / 60000);
  }

  /** 超过这个时长仍未释放，视为卡死，允许接管。 */
  private static readonly STALE_LOCK_MS = 15 * 60 * 1000;

  private emitRunState(groupId: string) {
    this.emit('run_state', this.getGroupRunState(groupId));
  }

  private setPendingRun(pendingRun: PendingGroupRun) {
    this.pendingRuns.set(pendingRun.groupId, pendingRun);
    this.emitRunState(pendingRun.groupId);
  }

  private clearPendingRun(groupId: string, messageId?: number) {
    const current = this.pendingRuns.get(groupId);
    if (!current) return;
    if (typeof messageId === 'number' && current.messageId !== messageId) return;
    this.pendingRuns.delete(groupId);
    this.emitRunState(groupId);
  }

  private setActiveRun(activeRun: ActiveGroupRun) {
    this.pendingRuns.delete(activeRun.groupId);
    this.activeRuns.set(activeRun.groupId, activeRun);
    this.emitRunState(activeRun.groupId);
  }

  private updateActiveRunOutput(groupId: string, runId: string, output: SplitGroupProcessOutputResult & { rawText: string }) {
    const activeRun = this.activeRuns.get(groupId);
    if (!activeRun || activeRun.runId !== runId) return;
    activeRun.rawText = selectPreferredTextSnapshot(activeRun.rawText, output.rawText);
    activeRun.text = selectPreferredTextSnapshot(activeRun.text, output.finalContent);
    activeRun.processContent = selectPreferredTextSnapshot(activeRun.processContent, output.processContent);
    activeRun.processStreaming = output.processStreaming;
  }

  private clearActiveRun(groupId: string, runId?: string) {
    const current = this.activeRuns.get(groupId);
    if (!current) return;
    if (runId && current.runId !== runId) return;
    this.activeRuns.delete(groupId);
    this.emitRunState(groupId);
  }

  private isTurnCurrent(turn: TurnContext): boolean {
    return this.fence.isCurrent(turn.input.groupId, turn.input.member.id, turn.fence);
  }

  private throwIfTurnStale(turn: TurnContext): void {
    if (!this.isTurnCurrent(turn)) throw new GroupResetInterruptedError(turn.input.groupId);
  }

  /** 房间级隔离（清空 / 删除 / 停止 / 换工作区）：之前开跑的运行之后的一切写入都被拒。 */
  markGroupReset(groupId: string): number {
    return this.fence.fenceRoom(groupId);
  }

  /** 成员级隔离（中断单个成员）。 */
  markMemberInterrupted(groupId: string, memberId: string): number {
    return this.fence.interruptMember(groupId, memberId);
  }

  forceResetGroupState(groupId: string): void {
    const activeRun = this.activeRuns.get(groupId);
    const pendingRun = this.pendingRuns.get(groupId);
    const affectedAgentIds = new Set<string>();

    if (activeRun?.agentId) {
      affectedAgentIds.add(activeRun.agentId);
    }
    if (pendingRun?.agentId) {
      affectedAgentIds.add(pendingRun.agentId);
    }

    this.pendingRuns.delete(groupId);
    this.activeRuns.delete(groupId);
    this.emitRunState(groupId);

    for (const agentId of affectedAgentIds) {
      this.emit('typing_done', { groupId, agentId });
    }
  }

  getGroupRunState(groupId: string) {
    const activeRun = this.activeRuns.get(groupId);
    const pendingRun = this.pendingRuns.get(groupId);
    const currentRun = activeRun || pendingRun;
    return {
      groupId,
      active: this.hasBusyMember(groupId) || !!currentRun,
      agentId: currentRun?.agentId || null,
      runId: activeRun?.runId || null,
      startedAt: currentRun?.startedAt || null,
    };
  }

  /** 「群里还有事在跑吗」——展示层与编辑重跑用，包含成员锁。 */
  isGroupProcessing(groupId: string) {
    return this.hasBusyMember(groupId) || this.pendingRuns.has(groupId) || this.activeRuns.has(groupId);
  }

  getGroupActiveRunMessage(groupId: string) {
    const currentRun = this.activeRuns.get(groupId) || this.pendingRuns.get(groupId);
    if (!currentRun || typeof currentRun.messageId !== 'number') {
      return null;
    }

    return {
      groupId,
      id: currentRun.messageId,
      parent_id: currentRun.parentId ?? null,
      sender_type: 'agent',
      sender_id: currentRun.agentId,
      sender_name: currentRun.agentName,
      content: currentRun.text,
      process_content: currentRun.processContent,
      process_streaming: currentRun.processStreaming,
      model_used: currentRun.modelUsed,
      created_at: currentRun.createdAt || new Date(currentRun.startedAt).toISOString(),
    };
  }

  async abortGroupRun(groupId: string): Promise<{ aborted: boolean }> {
    const activeRun = this.activeRuns.get(groupId);
    if (!activeRun) {
      return { aborted: false };
    }

    try {
      const result = await activeRun.client.abortChat({
        sessionKey: activeRun.sessionKey,
        runId: activeRun.runId,
      });
      this.clearActiveRun(groupId, activeRun.runId);
      this.emit('typing_done', { groupId, agentId: activeRun.agentId });
      return { aborted: result.aborted };
    } catch (error) {
      console.error(`[GroupChatEngine] Failed to abort run for group ${groupId}:`, error);
      throw error;
    }
  }

  /** 中断群里某个网关成员正在跑的那一轮（外部成员经协调器中止）。 */
  async abortGatewayMember(groupId: string, agentId: string): Promise<boolean> {
    const activeRun = this.activeRuns.get(groupId);
    if (!activeRun || activeRun.agentId !== agentId) return false;
    const result = await this.abortGroupRun(groupId);
    return result.aborted;
  }

  private resolveMemberDisplayName(member: GroupMemberRow): string {
    const linkedSession = this.db.getSessionByAgentId(member.agent_id) || this.db.getSession(member.agent_id);
    const latestName = linkedSession?.name?.trim();
    return latestName || member.display_name;
  }

  resolveMembers(members: GroupMemberRow[]): GroupMemberRow[] {
    return members.map((member) => {
      const latestName = this.resolveMemberDisplayName(member);
      return latestName === member.display_name ? member : { ...member, display_name: latestName };
    });
  }

  private resolveGroupParentId(groupId: string): number | undefined {
    // Group chats are strictly linear. Always attach new messages to the latest
    // persisted group message instead of honoring any older valid parent id.
    return this.db.getLatestGroupMessageId(groupId);
  }

  saveSystemNotice(
    groupId: string,
    parentId: number | undefined,
    notice: Required<StructuredGroupMessage> & { content: string },
  ): number {
    const noticeId = this.db.saveGroupMessage({
      group_id: groupId,
      parent_id: parentId,
      sender_type: 'agent',
      sender_id: 'system',
      sender_name: '系统',
      content: notice.content,
    });
    this.emit('message', {
      groupId,
      id: noticeId,
      parent_id: parentId,
      sender_type: 'agent',
      sender_id: 'system',
      sender_name: '系统',
      content: notice.content,
      messageCode: notice.messageCode,
      messageParams: notice.messageParams,
      created_at: new Date().toISOString(),
    });
    return noticeId;
  }

  /**
   * 按「成员引用」查成员。引用可能是裸的 `agent_id`，也可能是外部成员的
   * `sender_id`（`ext:<runtime>:<agentId>`）——后者会从重新生成、运行恢复这些地方回传进来。
   * 判据只实现一次，放在这里。
   */
  resolveMemberByAgentRef(members: GroupMemberRow[], ref: string): GroupMemberRow | undefined {
    const direct = members.find((m) => m.agent_id === ref);
    if (direct) return direct;

    const parsed = parseExternalSenderId(ref);
    if (!parsed) return undefined;
    // 运行时也要对上：同名 agentId 换了运行时就是另一回事。
    return members.find((m) => m.agent_id === parsed.agentId && (m.runtime || 'openclaw') === parsed.runtime);
  }

  /** 外部成员的默认工作目录：本群工作区（按需创建）。单独成方法，便于用例替身而不去碰真实的 ~/.openclaw。 */
  resolveExternalMemberWorkspace(groupId: string): string {
    return ensureGroupWorkspace(groupId).workspacePath;
  }

  /**
   * 执行一跳（编排器的 `MemberTurnExecutor`）。成员锁在这里取、在 finally 里放；
   * 外部成员与网关成员分两条路；网关成员同群串行。
   */
  async executeTurn(input: ExecuteTurnInput): Promise<MemberTurnResult> {
    const { groupId, member } = input;
    const agentId = member.agent_id;
    const parentId = this.resolveGroupParentId(groupId);

    // 每成员一把锁。拿不到说明这个成员正在跑上一轮——**说出来**，不要静默。
    if (!this.acquireMemberLock(groupId, agentId)) {
      this.saveSystemNotice(groupId, parentId, createMemberBusyMessage(member.display_name));
      return { status: 'busy', messageId: null, text: '', errorCode: MEMBER_BUSY_MESSAGE_CODE };
    }
    try {
      const turn: TurnContext = {
        input,
        parentId,
        fence: this.fence.token(groupId, member.id),
        idleMs: input.policy.runIdleTimeoutSec * 1000,
        totalMs: input.policy.runTotalBudgetSec * 1000,
        scope: NOOP_SCOPE,
      };
      if ((member.runtime || 'openclaw') !== 'openclaw') {
        return await this.runExternalMember(turn);
      }
      const previous = this.gatewayTurnChains.get(groupId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const chain = previous.catch(() => undefined).then(() => gate);
      this.gatewayTurnChains.set(groupId, chain);
      await previous.catch(() => undefined);
      try {
        // 排队期间房间可能被清空：令牌是进来时取的，开跑前再比一次。
        if (!this.isTurnCurrent(turn)) return { status: 'reset', messageId: null, text: '' };
        return await this.runGatewayMemberWithScope(turn);
      } finally {
        release();
        if (this.gatewayTurnChains.get(groupId) === chain) this.gatewayTurnChains.delete(groupId);
      }
    } finally {
      // 锁必须在这里放，不能在某个 return 出口放——中途抛错、被停止打断、
      // 上游超时都会跳过那些出口，而成员锁一旦漏放就只能等 15 分钟陈旧接管。
      this.releaseMemberLock(groupId, agentId);
    }
  }

  private async runGatewayMemberWithScope(turn: TurnContext): Promise<MemberTurnResult> {
    const { groupId } = turn.input;
    const workspace = ensureGroupWorkspace(groupId).workspacePath;
    turn.scope = this.turnHooks ? await this.turnHooks.beginRun(turn.input, workspace) : NOOP_SCOPE;
    let result: MemberTurnResult = { status: 'failed', messageId: null, text: '', error: 'not started' };
    try {
      result = await this.runGatewayMember(turn);
      return result;
    } finally {
      await turn.scope.finish({ messageId: result.messageId, status: result.status, runMarker: null }).catch((error) => {
        console.warn(`[GroupChat] run scope finish failed for ${groupId}:`, (error as Error)?.message);
      });
    }
  }

  /**
   * 外部运行时成员的派发路径（含远程 Agent relay）。
   *
   * 会话只在成功时落库：实测 `--resume` 指向不存在的会话会失败退出（No conversation found with session ID），
   * 所以失败的那一轮若把 uuid 写进去，之后每一轮都会拿着一个死会话去 resume，永久失败。
   */
  private async runExternalMember(turn: TurnContext, adapterOverride?: AgentRuntimeAdapter<RuntimeRunRequest>): Promise<MemberTurnResult> {
    const { groupId, member } = turn.input;
    const parentId = turn.parentId;
    const runtime = member.runtime || 'claude-code';
    const senderId = externalSenderId(runtime, member.agent_id);

    let config: any = {};
    try {
      config = member.external_config ? JSON.parse(member.external_config) : {};
    } catch {
      // 坏 JSON 不该让这个成员彻底不能用——退回默认值，工作目录缺失时下面会报错。
      console.warn(`[GroupChat] 成员 ${member.agent_id} 的 external_config 解析失败，按默认值处理`);
    }

    // 只取**能续**的那个：状态不允许续话时当作没有，重开一个新会话。
    const existingSession = this.db.getResumableExternalSession(groupId, member.id);
    const sessionId = existingSession ?? randomUUID();
    const resume = Boolean(existingSession);

    const createdAt = new Date().toISOString();
    const modelTag = config.model || runtime;
    const msgId = this.db.saveGroupMessage({
      group_id: groupId,
      parent_id: parentId,
      sender_type: 'agent',
      sender_id: senderId,
      sender_name: member.display_name,
      content: '',
      process_content: '',
      model_used: modelTag,
      created_at: createdAt,
    });
    turn.input.onReplyCreated(msgId);

    const basePayload = {
      groupId,
      id: msgId,
      parent_id: parentId,
      sender_type: 'agent' as const,
      sender_id: senderId,
      sender_name: member.display_name,
      model_used: modelTag,
      created_at: createdAt,
    };
    this.emit('message', { ...basePayload, content: '', process_content: '', process_streaming: false });
    this.emit('typing', { groupId, agentId: member.agent_id, displayName: member.display_name });

    // 没配工作目录的成员落在本群工作区。不能退回 process.cwd()：global 模式的外部 CLI 会跳过沙箱执行命令，
    // 那等于把 ClawOPT 自己的安装目录交给它。
    const memberWorkspace = typeof config.workingDir === 'string' && config.workingDir.trim()
      ? config.workingDir
      : this.resolveExternalMemberWorkspace(groupId);
    const adapter = adapterOverride ?? this.runtimeAdapters?.(runtime) ?? null;

    if (!adapter) {
      // 库里存了一个这版 ClawOPT 没登记适配器的运行时：说清楚，不静默退回 OpenClaw（v1.3.0 那种「选了不生效」）。
      const message = `${member.display_name} 执行失败（runtime.unknown: ${runtime}）`;
      this.db.updateGroupMessage(msgId, message, modelTag, undefined, '');
      this.emit('edit', { ...basePayload, content: message, process_content: '', process_streaming: false });
      this.emit('typing_done', { groupId, agentId: member.agent_id });
      return { status: 'failed', messageId: msgId, text: '', error: `runtime.unknown: ${runtime}`, errorCode: 'runtime.unknown' };
    }

    turn.scope = this.turnHooks ? await this.turnHooks.beginRun(turn.input, memberWorkspace) : NOOP_SCOPE;
    let result: MemberTurnResult = { status: 'failed', messageId: msgId, text: '', error: 'not started' };
    let runMarker: string | null = null;
    const sessionKey = externalMemberSessionKey(groupId, member.id);
    let watchdog: RunWatchdog | null = null;
    try {
      // 群上下文（摘要、转录、名册、@ 协议、安全提示）在 prompt 里（v2，红线 A 的快照守着）；
      // 成员配置里的追加指令不进 prompt，经运行时的指令文件传入，不顶掉对方自己的项目指令。
      const prompt = this.turnHooks
        ? this.turnHooks.buildPrompt(turn.input, {
          workspace: { root: memberWorkspace, uploads: null, output: null },
          processTags: null,
          hostTakeoverPrompt: null,
          triggerText: turn.input.payload.triggerText,
        }, turn.scope)
        : turn.input.payload.triggerText;
      const request: RuntimeRunRequest = {
        // 成员配置里选了 scoped（ClawOPT 选服务商与模型、CLI 只连本地代理）才走 scoped；缺省 global（CLI 用自己的登录）。
        mode: config.mode === 'scoped' ? 'scoped' : 'global',
        // 运行时 home 按 (群, 成员) 稳定：同一成员跨轮次共用一份原生会话与配置；删成员 / 删群时按它回收。
        owner: { kind: 'room-member', groupId, memberId: member.id, agentId: member.agent_id },
        sessionId,
        resume,
        prompt,
        workspace: memberWorkspace,
        model: typeof config.model === 'string' ? config.model : undefined,
        reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
        allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools : undefined,
        maxBudgetUsd: typeof config.maxBudgetUsd === 'number' ? config.maxBudgetUsd : undefined,
        // 成员配置（远程网关地址、scoped 的服务商与模型、relay 的 connector 等，不含密钥）+ 这一跳的作用域（远程工作区令牌）。
        runtimeConfig: { ...config, ...turn.scope.runtimeConfig },
        instructions: typeof config.appendSystemPrompt === 'string' ? config.appendSystemPrompt : undefined,
      };

      // 运行交给协调器：会话行、run marker、陈旧事件、中止、用量去重、工具调用落库、终态顺序都在那里。
      // 这里只剩外部成员自己的约定：消息行（投影器）、续话会话（external_sessions）、隔离与超时。
      const coordinator = this.requireRunCoordinator();
      const submitted = await coordinator.submit({
        sessionKey,
        surface: 'room',
        topics: [roomTopic(groupId), agentTopic(senderId)],
        agentId: senderId,
        title: member.display_name,
        adapter,
        request,
        // 仲裁表的用量维度按模式选路（scoped 信代理、global 信 CLI）：不传的话 scoped 成员会记 CLI 的估计值、丢掉代理的真实计费。
        proxyMode: request.mode,
        projector: (run) => {
          runMarker = run.runMarker;
          return createExternalMemberProjector({
            db: this.db,
            emit: (event, payload) => this.emit(event, payload),
            run,
            basePayload,
            displayName: member.display_name,
            modelTag,
            isCurrent: () => this.isTurnCurrent(turn),
            onActivity: () => watchdog?.touch(),
            failureDetail: () => watchdog?.reason ?? null,
          });
        },
        workspacePath: memberWorkspace,
        meta: { groupId, memberId: member.id, messageId: msgId },
      }, 'reject');
      if (submitted.status !== 'started') {
        const message = `${member.display_name} 执行失败（busy）`;
        this.db.updateGroupMessage(msgId, message, modelTag, undefined, '');
        this.emit('edit', { ...basePayload, content: message, process_content: '', process_streaming: false });
        result = { status: 'busy', messageId: msgId, text: '', error: 'busy' };
        return result;
      }
      watchdog = new RunWatchdog(turn.idleMs, turn.totalMs, () => {
        void coordinator.abort(sessionKey, 'user_stop');
      });
      const { outcome, projection } = await submitted.completion;
      watchdog.stop();

      if (!this.isTurnCurrent(turn)) {
        result = { status: 'reset', messageId: null, text: '' };
        return result;
      }

      if (outcome.kind === 'completed') {
        // 只有成功才把会话记下来。
        this.db.setExternalSession(groupId, member.id, sessionId);
        result = { status: 'completed', messageId: msgId, text: projection.output ?? '' };
        return result;
      }

      // 失败不删行，只标状态——行留着，排障才看得到「上次为什么失败」。
      // 超时分成两种记：硬超时与中断的处置本来就不同（看门狗到点记成对应的超时）。
      const failureStatus = watchdog.reason ?? (outcome.kind === 'aborted' ? 'cancelled'
        : outcome.stopReason === 'hard_timeout' ? 'hard_timeout'
          : outcome.stopReason === 'idle_timeout' ? 'idle_timeout'
            : 'failed');
      const detail = watchdog.reason ?? describeExternalFailure(outcome);
      if (resume) {
        this.db.markExternalSessionUnusable(groupId, member.id, failureStatus, detail);
      } else {
        // 首轮就失败：先把行建出来再标，否则没有行可标，那次失败不留痕迹。
        this.db.setExternalSession(groupId, member.id, sessionId);
        this.db.markExternalSessionUnusable(groupId, member.id, failureStatus, detail);
      }
      result = {
        status: outcome.kind === 'aborted' && !watchdog.reason ? 'aborted' : 'failed',
        messageId: msgId,
        text: '',
        error: detail,
        errorCode: outcome.kind === 'failed' ? outcome.code : watchdog.reason ?? undefined,
      };
      return result;
    } finally {
      watchdog?.stop();
      this.emit('typing_done', { groupId, agentId: member.agent_id });
      await turn.scope.finish({ messageId: result.messageId, status: result.status, runMarker }).catch((error) => {
        console.warn(`[GroupChat] run scope finish failed for ${groupId}:`, (error as Error)?.message);
      });
    }
  }

  private async runGatewayMember(turn: TurnContext): Promise<MemberTurnResult> {
    const { groupId, member } = turn.input;
    const agentId = member.agent_id;
    const triggerMsg = turn.input.payload.triggerText;
    const parentId = turn.parentId;

    // Emit typing indicator
    this.emit('typing', { groupId, agentId, displayName: member.display_name });
    let msgId: number | undefined;
    let activeRunId: string | null = null;
    let typingFinished = false;
    const placeholderCreatedAt = new Date().toISOString();
    const modelUsed = this.getAgentModel(agentId);
    let latestProcessOutput = '';
    let runtimeWorkspacePath = '';
    const progressLocale = normalizeGroupToolProgressLocale(this.getPreferredLanguage());
    let sessionEventsClient: OpenClawClient | null = null;
    let sessionEventsSubscribed = false;

    const finishTyping = () => {
      if (typingFinished) return;
      typingFinished = true;
      this.emit('typing_done', { groupId, agentId });
    };

    try {
      msgId = this.db.saveGroupMessage({
        group_id: groupId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: agentId,
        sender_name: member.display_name,
        content: '',
        process_content: '',
        model_used: modelUsed,
        created_at: placeholderCreatedAt,
      });
      turn.input.onReplyCreated(msgId);

      this.emit('message', {
        groupId,
        id: msgId,
        parent_id: parentId,
        sender_type: 'agent',
        sender_id: agentId,
        sender_name: member.display_name,
        content: '',
        process_content: '',
        process_streaming: false,
        model_used: modelUsed,
        created_at: placeholderCreatedAt
      });
      this.setPendingRun({
        groupId,
        agentId,
        agentName: member.display_name,
        startedAt: Date.now(),
        messageId: msgId,
        parentId,
        modelUsed,
        createdAt: placeholderCreatedAt,
        rawText: '',
        text: '',
        processContent: '',
        processStreaming: false,
      });

      const group = this.db.getGroupChat(groupId);
      const runtimeContext = await this.prepareGroupRuntime(groupId, agentId);
      runtimeWorkspacePath = runtimeContext.workspacePath;
      this.throwIfTurnStale(turn);
      
      const isResetCommand = triggerMsg.trim() === '/new';
      const memberSessionConfig = this.db.getSessionByAgentId(agentId);
      const { startTag: processStartTag, endTag: processEndTag } = resolveConfiguredProcessTagPair(
        group?.process_start_tag,
        group?.process_end_tag,
        memberSessionConfig?.process_start_tag,
        memberSessionConfig?.process_end_tag,
      );
      const rewrittenTrigger = isResetCommand
        ? { text: triggerMsg, attachments: [] as MessageAttachment[], linkedUploads: [] as WorkspaceUploadLink[] }
        : rewriteMessageWithWorkspaceUploads(triggerMsg, runtimeContext.uploadsPath, { extractImageAttachments: true });
      const canUseHostTakeover = this.canUseHostTakeover(agentId);
      if (!isResetCommand && canUseHostTakeover && hasDocumentUploads(rewrittenTrigger.linkedUploads)) {
        try {
          await ensureManagedDocumentToolingReady();
        } catch (error) {
          console.error('[GroupChatEngine] Failed to prepare managed document tooling runtime:', error);
        }
      }
      this.throwIfTurnStale(turn);
      const imageInspectionContext = isResetCommand
        ? ''
        : buildImageUploadInspectionContext(rewrittenTrigger.linkedUploads);
      const documentToolingContext = isResetCommand
        ? ''
        : (canUseHostTakeover ? buildDocumentToolingContext(rewrittenTrigger.linkedUploads) : '');
      const audioTranscriptContext = isResetCommand
        ? ''
        : buildAudioTranscriptContext(
          await prepareAudioTranscriptsFromUploads(rewrittenTrigger.linkedUploads, runtimeContext.runtimeAgentId)
        );
      this.throwIfTurnStale(turn);
      const promptInput = [rewrittenTrigger.text, imageInspectionContext, documentToolingContext, audioTranscriptContext].filter(Boolean).join('\n\n').trim();

      const imageIntentContext = runtimeContext.bootstrapContext || '';
      const imageGenerationStartProcessContent = !isResetCommand && shouldUseConfiguredImageGenerationModel(triggerMsg, imageIntentContext)
        ? this.buildImageGenerationStartProcessContent?.()
        : null;
      if (imageGenerationStartProcessContent && msgId !== undefined) {
        latestProcessOutput = imageGenerationStartProcessContent;
        this.db.updateGroupMessage(msgId, '', modelUsed, null, imageGenerationStartProcessContent);
        this.emit('edit', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: agentId,
          sender_name: member.display_name,
          content: '',
          process_content: rewriteVisibleFileLinks(imageGenerationStartProcessContent, { workspacePath: runtimeContext.workspacePath }).trim(),
          process_streaming: true,
          model_used: modelUsed,
          created_at: placeholderCreatedAt,
        });
      }

      const directImageResult = !isResetCommand && this.tryGenerateImageForPrompt
        ? await this.tryGenerateImageForPrompt({
          prompt: promptInput,
          intentText: triggerMsg,
          intentContext: imageIntentContext,
          outputDir: runtimeContext.outputPath,
        })
        : null;
      if (directImageResult && msgId !== undefined) {
        this.throwIfTurnStale(turn);
        latestProcessOutput = directImageResult.processContent;
        this.db.updateGroupMessage(
          msgId,
          directImageResult.content,
          directImageResult.modelUsed,
          null,
          directImageResult.processContent,
        );
        this.emit('edit', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: agentId,
          sender_name: member.display_name,
          content: rewriteVisibleFileLinks(directImageResult.content, { workspacePath: runtimeContext.workspacePath }).trim(),
          process_content: rewriteVisibleFileLinks(directImageResult.processContent, { workspacePath: runtimeContext.workspacePath }).trim(),
          process_streaming: false,
          model_used: directImageResult.modelUsed,
          created_at: placeholderCreatedAt,
        });
        return { status: 'completed', messageId: msgId, text: directImageResult.content };
      }

      // 上下文（摘要、清洗过的转录、名册、非主人安全提示）由协作层按 v2 构建；`/new` 原样交给网关（重置会话命令）。
      const prompt = isResetCommand
        ? triggerMsg
        : this.requireTurnHooks().buildPrompt(turn.input, {
          workspace: { root: runtimeContext.workspacePath, uploads: runtimeContext.uploadsPath, output: runtimeContext.outputPath },
          processTags: processStartTag && processEndTag ? { startTag: processStartTag, endTag: processEndTag } : null,
          hostTakeoverPrompt: canUseHostTakeover ? buildGroupHostTakeoverPrompt() : null,
          triggerText: promptInput,
          rewriteContent: (text) => rewriteMessageWithWorkspaceUploads(text, runtimeContext.uploadsPath, { extractImageAttachments: false }).text,
        }, turn.scope);

      // Use the group's ID as the session key so it isolates memory per group
      // Tools (browser, code execution, etc.) are granted via agentId, not sessionKey.
      const sessionKey = getGroupRuntimeSessionKey(groupId, group?.runtime_session_epoch);
      const client = await this.getClient(runtimeContext.runtimeAgentId);
      sessionEventsClient = client;
      this.throwIfTurnStale(turn);
      try {
        await client.subscribeSessionEvents();
        sessionEventsSubscribed = true;
      } catch (error) {
        console.warn(`[GroupChatEngine] Failed to subscribe session events for group ${groupId}, agent ${agentId}:`, error);
      }
      const expectedSessionKey = sessionKey.startsWith('agent:')
        ? sessionKey
        : `agent:${runtimeContext.runtimeAgentId}:chat:${sessionKey}`;
      const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, GROUP_HISTORY_COMPLETION_PROBE_LIMIT)
        .then((history) => getHistorySnapshot(history))
        .catch(() => getUnknownHistorySnapshot());
      this.throwIfTurnStale(turn);

      // Start streaming response
      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey,
        message: prompt,
        agentId: runtimeContext.runtimeAgentId,
        attachments: rewrittenTrigger.attachments,
      });
      if (!this.isTurnCurrent(turn)) {
        try {
          await client.abortChat({ sessionKey: finalSessionKey, runId });
        } catch {}
        throw new GroupResetInterruptedError(groupId);
      }
      const runStartedAt = Date.now();
      activeRunId = runId;
      this.setActiveRun({
        groupId,
        agentId,
        agentName: member.display_name,
        runId,
        sessionKey: finalSessionKey,
        client,
        startedAt: runStartedAt,
        messageId: msgId,
        parentId: parentId,
        modelUsed,
        createdAt: placeholderCreatedAt,
        rawText: '',
        text: '',
        processContent: '',
        processStreaming: false,
      });

      // Listen for stream events
      let visibleFinalOutput = '';
      let visibleProcessOutput = '';
      let rawOutput = '';
      let finalOutput = '';
      let processOutput = '';
      let toolProcessOutput = '';
      let finalEventText = '';
      const response = await new Promise<string>((resolve, reject) => {
        let idleTimeout: NodeJS.Timeout | null = null;
        // 总预算（从开跑算，不随事件续期）：到点中止网关运行并按失败收尾。空闲超时见 resetIdleTimeout。
        const totalBudgetTimer = setTimeout(() => {
          void client.abortChat({ sessionKey: finalSessionKey, runId }).catch(() => undefined);
          rejectOnce(new Error('Run exceeded the total time budget (hard_timeout).'));
        }, turn.totalMs);
        totalBudgetTimer.unref?.();
        let completionProbeTimer: NodeJS.Timeout | null = null;
        let completionProbeInFlight = false;
        let completionProbePending = false;
        let settled = false;
        let firstCompletionWaitResolvedAt: number | null = null;
        let finalEventGeneration = 0;
        let settledCalibrationGeneration = 0;
        let latestFinalEventAt: number | null = null;
        let pendingErrorDetail = '';
        let lastObservedHistoryLength = preRunHistorySnapshot.length;
        let lastObservedHistorySignature = preRunHistorySnapshot.latestSignature;
        let lastObservedHistoryActivityAt: number | null = null;
        let visibleProcessStreaming = false;
        let modelProcessStreaming = false;
        const toolProcessLines: string[] = [];
        const activeToolCallIds = new Set<string>();
        const toolProgressById = new Map<string, GroupToolProgressState>();

        const isRelevantToolEvent = (payload: {
          sessionKey?: string;
          parentSessionKey?: string;
          runId?: string;
        }) => {
          if (payload.runId === runId) {
            return true;
          }
          if (payload.sessionKey === finalSessionKey) {
            return true;
          }
          if (payload.parentSessionKey === finalSessionKey) {
            return true;
          }
          return false;
        };

        const syncCombinedProcessState = () => {
          const combinedProcessOutput = combineGroupProcessContent(toolProcessOutput, processOutput);
          const combinedProcessStreaming = modelProcessStreaming || activeToolCallIds.size > 0;
          latestProcessOutput = combinedProcessOutput;
          this.updateActiveRunOutput(groupId, runId, {
            rawText: rawOutput,
            finalContent: finalOutput,
            processContent: combinedProcessOutput,
            processStreaming: combinedProcessStreaming,
          });
          return { combinedProcessOutput, combinedProcessStreaming };
        };

        const emitVisiblePatchIfChanged = (
          eventName: 'delta' | 'edit',
          options?: { trimVisibleContent?: boolean; trimVisibleProcess?: boolean; force?: boolean },
        ) => {
          const { combinedProcessOutput, combinedProcessStreaming } = syncCombinedProcessState();
          if (!this.isTurnCurrent(turn)) {
            // 房间被清空 / 删除 / 成员被中断之后到的事件：一个字节都不写，停掉这次运行。
            void client.abortChat({ sessionKey: finalSessionKey, runId }).catch(() => undefined);
            rejectOnce(new GroupResetInterruptedError(groupId));
            return { combinedProcessOutput, combinedProcessStreaming, nextVisibleFinalOutput: visibleFinalOutput, nextVisibleProcessOutput: visibleProcessOutput, didVisibleChange: false };
          }
          const nextVisibleFinalOutputRaw = rewriteVisibleFileLinks(finalOutput, { workspacePath: runtimeContext.workspacePath });
          const nextVisibleProcessOutputRaw = rewriteVisibleFileLinks(combinedProcessOutput, { workspacePath: runtimeContext.workspacePath });
          const nextVisibleFinalOutput = options?.trimVisibleContent ? nextVisibleFinalOutputRaw.trim() : nextVisibleFinalOutputRaw;
          const nextVisibleProcessOutput = options?.trimVisibleProcess === false
            ? nextVisibleProcessOutputRaw
            : nextVisibleProcessOutputRaw.trim();
          const didVisibleChange = nextVisibleFinalOutput !== visibleFinalOutput
            || nextVisibleProcessOutput !== visibleProcessOutput
            || combinedProcessStreaming !== visibleProcessStreaming;

          if (!options?.force && !didVisibleChange) {
            return {
              combinedProcessOutput,
              combinedProcessStreaming,
              nextVisibleFinalOutput,
              nextVisibleProcessOutput,
              didVisibleChange: false,
            };
          }

          if (msgId !== undefined) {
            this.db.updateGroupMessage(msgId, finalOutput, modelUsed, undefined, combinedProcessOutput);
          }

          visibleFinalOutput = nextVisibleFinalOutput;
          visibleProcessOutput = nextVisibleProcessOutput;
          visibleProcessStreaming = combinedProcessStreaming;

          this.emit(eventName, {
            groupId,
            id: msgId,
            parent_id: parentId,
            sender_type: 'agent',
            sender_id: agentId,
            sender_name: member.display_name,
            model_used: modelUsed,
            created_at: placeholderCreatedAt,
            content: nextVisibleFinalOutput,
            process_content: nextVisibleProcessOutput,
            process_streaming: combinedProcessStreaming,
          });

          return {
            combinedProcessOutput,
            combinedProcessStreaming,
            nextVisibleFinalOutput,
            nextVisibleProcessOutput,
            didVisibleChange: true,
          };
        };

        const clearIdleTimeout = () => {
          if (idleTimeout) {
            clearTimeout(idleTimeout);
            idleTimeout = null;
          }
        };

        const clearCompletionProbeTimer = () => {
          if (completionProbeTimer) {
            clearTimeout(completionProbeTimer);
            completionProbeTimer = null;
          }
        };

        const cleanup = () => {
          clearTimeout(totalBudgetTimer);
          clearIdleTimeout();
          clearCompletionProbeTimer();
          client.off('chat.delta', onDelta);
          client.off('chat.final', onFinal);
          client.off('chat.error', onError);
          client.off('chat.aborted', onAborted);
          client.off('session.tool', onSessionTool);
          client.off('disconnected', onDisconnect);
          if (sessionEventsSubscribed) {
            sessionEventsSubscribed = false;
            void client.unsubscribeSessionEvents().catch((error) => {
              console.warn(`[GroupChatEngine] Failed to unsubscribe session events for group ${groupId}, agent ${agentId}:`, error);
            });
          }
        };

        const resolveOnce = (value: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const resetIdleTimeout = () => {
          clearIdleTimeout();
          idleTimeout = setTimeout(() => {
            rejectOnce(new Error((finalOutput.trim() || latestProcessOutput.trim()) ? 'Stream interrupted (idle timeout).' : 'Stream timed out (no response).'));
          }, turn.idleMs);
        };

        const scheduleCompletionProbe = (delay = GROUP_STREAM_COMPLETION_PROBE_DELAY_MS) => {
          if (settled) return;
          completionProbePending = true;
          clearCompletionProbeTimer();
          completionProbeTimer = setTimeout(() => {
            completionProbeTimer = null;
            if (completionProbeInFlight) {
              return;
            }
            completionProbePending = false;
            void probeCompletion();
          }, delay);
        };

        const probeCompletion = async () => {
          if (settled || completionProbeInFlight) return;
          completionProbeInFlight = true;
          const probeFinalGeneration = finalEventGeneration;

          try {
            await client.waitForRun(runId, GROUP_STREAM_COMPLETION_WAIT_TIMEOUT_MS);
            if (firstCompletionWaitResolvedAt === null) {
              firstCompletionWaitResolvedAt = Date.now();
            }
            if (settled) return;

            let completedOutput = selectPreferredTextSnapshot(finalOutput, finalEventText);
            let settledErrorDetail = '';
            let shouldRetryForEmptyCompletion = false;
            let bestSettledAssistantText = '';
            const visibleFinalGraceDeadline = probeFinalGeneration > 0
              && completedOutput.trim()
              && latestFinalEventAt !== null
              ? latestFinalEventAt + GROUP_FINAL_EVENT_SETTLE_GRACE_MS
              : null;
            try {
              const historyProbeStartedAt = Date.now();
              while (!settled && (Date.now() - historyProbeStartedAt) < GROUP_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS) {
                const history = await client.getChatHistory(finalSessionKey, GROUP_HISTORY_COMPLETION_PROBE_LIMIT);
                const historyTailActivity = getHistoryTailActivity(history, preRunHistorySnapshot);
                if (
                  historyTailActivity.hasChanges
                  && (
                    historyTailActivity.length !== lastObservedHistoryLength
                    || historyTailActivity.latestSignature !== lastObservedHistorySignature
                  )
                ) {
                  lastObservedHistoryLength = historyTailActivity.length;
                  lastObservedHistorySignature = historyTailActivity.latestSignature;
                  lastObservedHistoryActivityAt = Date.now();
                  resetIdleTimeout();
                }
                const settledAssistantOutcome = extractSettledAssistantOutcome(history, preRunHistorySnapshot);
                if (settledAssistantOutcome.kind === 'error') {
                  settledErrorDetail = settledAssistantOutcome.error;
                  break;
                }
                if (settledAssistantOutcome.kind === 'text') {
                  bestSettledAssistantText = settledAssistantOutcome.text;
                  const settledMatchesCurrent = settledAssistantOutcome.text.trim() === completedOutput.trim();
                  if (shouldPreferSettledAssistantText(completedOutput, settledAssistantOutcome.text)) {
                    completedOutput = selectPreferredTextSnapshot(completedOutput, settledAssistantOutcome.text);
                    break;
                  }
                  if (settledMatchesCurrent) {
                    break;
                  }
                }

                if (visibleFinalGraceDeadline !== null) {
                  const remainingVisibleFinalGraceMs = visibleFinalGraceDeadline - Date.now();
                  if (remainingVisibleFinalGraceMs <= 0) {
                    break;
                  }
                  await new Promise((resolve) => setTimeout(resolve, Math.min(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS, remainingVisibleFinalGraceMs)));
                  continue;
                }

                await new Promise((resolve) => setTimeout(resolve, GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS));
              }

              if (settledErrorDetail) {
                rejectOnce(new Error(settledErrorDetail));
                return;
              }

              if (shouldPreferSettledAssistantText(completedOutput, bestSettledAssistantText)) {
                completedOutput = selectPreferredTextSnapshot(completedOutput, bestSettledAssistantText);
              }
            } catch (historyError) {
              console.warn(`[GroupChatEngine] Failed to read final history for group ${groupId}, run ${runId}:`, historyError);
              shouldRetryForEmptyCompletion = true;
            }

            if (!completedOutput.trim()) {
              shouldRetryForEmptyCompletion = true;
            }

            completedOutput = selectPreferredTextSnapshot(completedOutput, finalEventText);

            const hasSettledAssistantText = bestSettledAssistantText.trim().length > 0;
            const hasStableVisibleFinalText = probeFinalGeneration > 0
              && probeFinalGeneration === finalEventGeneration
              && completedOutput.trim().length > 0
              && latestFinalEventAt !== null
              && Date.now() >= (latestFinalEventAt + GROUP_FINAL_EVENT_SETTLE_GRACE_MS);

            if (
              probeFinalGeneration > 0
              && probeFinalGeneration === finalEventGeneration
              && (hasSettledAssistantText || hasStableVisibleFinalText)
            ) {
              settledCalibrationGeneration = Math.max(settledCalibrationGeneration, probeFinalGeneration);
            }

            const isAwaitingInitialTerminalEvidence = finalEventGeneration === 0 && !hasSettledAssistantText;
            const isAwaitingSettledFinalCalibration = finalEventGeneration > settledCalibrationGeneration;
            const hasRecentHistoryActivity = lastObservedHistoryActivityAt !== null
              && (Date.now() - lastObservedHistoryActivityAt) < GROUP_HISTORY_ACTIVITY_GRACE_MS;

            if (
              (shouldRetryForEmptyCompletion || isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
              && hasRecentHistoryActivity
            ) {
              scheduleCompletionProbe(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS);
              return;
            }

            if (
              shouldRetryForEmptyCompletion
              && firstCompletionWaitResolvedAt !== null
              && (Date.now() - firstCompletionWaitResolvedAt) < GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS
            ) {
              scheduleCompletionProbe(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS);
              return;
            }

            if (
              (isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration)
              && firstCompletionWaitResolvedAt !== null
              && (Date.now() - firstCompletionWaitResolvedAt) < GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS
            ) {
              scheduleCompletionProbe(GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS);
              return;
            }

            if ((isAwaitingInitialTerminalEvidence || isAwaitingSettledFinalCalibration) && completedOutput.trim() && !pendingErrorDetail) {
              console.warn(
                `[GroupChatEngine] Finalizing run ${runId} for group ${groupId}, agent ${agentId} using streamed text fallback because terminal assistant evidence never settled.`,
              );
              resolveOnce(completedOutput);
              return;
            }

            if (isAwaitingInitialTerminalEvidence) {
              rejectOnce(new Error(pendingErrorDetail || 'Run completed without a terminal assistant response.'));
              return;
            }

            if (isAwaitingSettledFinalCalibration) {
              rejectOnce(new Error(pendingErrorDetail || 'Run completed but the final assistant response never settled.'));
              return;
            }

            if (!completedOutput.trim() && pendingErrorDetail) {
              rejectOnce(new Error(pendingErrorDetail));
              return;
            }

            resolveOnce(completedOutput);
          } catch (error: any) {
            if (settled) return;
            const detail = typeof error?.message === 'string' ? error.message : '';
            if (/timeout/i.test(detail)) {
              scheduleCompletionProbe();
              return;
            }
            rejectOnce(new Error(pendingErrorDetail || detail || 'Failed waiting for group run completion.'));
          } finally {
            completionProbeInFlight = false;
            if (!settled && completionProbePending && !completionProbeTimer) {
              scheduleCompletionProbe(0);
            }
          }
        };

        const onDelta = (data: { sessionKey: string; runId: string; text: string }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            const nextRawOutput = selectPreferredTextSnapshot(rawOutput, data.text);
            const didOutputChange = nextRawOutput !== rawOutput;
            rawOutput = nextRawOutput;
            const splitOutput = splitGroupProcessOutput(rawOutput, processStartTag, processEndTag);
            finalOutput = splitOutput.finalContent;
            processOutput = splitOutput.processContent;
            modelProcessStreaming = splitOutput.processStreaming;
            if (!didOutputChange) {
              syncCombinedProcessState();
              resetIdleTimeout();
              scheduleCompletionProbe();
              return;
            }
            emitVisiblePatchIfChanged('delta', { trimVisibleContent: false, trimVisibleProcess: false });
            resetIdleTimeout();
            scheduleCompletionProbe();
          }
        };

        const onFinal = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            const finalEventObservedAt = Date.now();
            const terminalFinalText = resolveChatFinalTextSnapshot(data.text, data.message);
            if (terminalFinalText) {
              const splitFinalEvent = splitGroupProcessOutput(terminalFinalText, processStartTag, processEndTag);
              finalEventText = selectPreferredTextSnapshot(finalEventText, splitFinalEvent.finalContent);
              rawOutput = selectPreferredTextSnapshot(rawOutput, terminalFinalText);
              finalOutput = selectPreferredTextSnapshot(finalOutput, splitFinalEvent.finalContent);
              processOutput = selectPreferredTextSnapshot(processOutput, splitFinalEvent.processContent);
              modelProcessStreaming = splitFinalEvent.processStreaming;
              latestFinalEventAt = finalEventObservedAt;
              finalEventGeneration += 1;
            } else if (data.text) {
              rawOutput = selectPreferredTextSnapshot(rawOutput, data.text);
              const splitOutput = splitGroupProcessOutput(rawOutput, processStartTag, processEndTag);
              finalOutput = selectPreferredTextSnapshot(finalOutput, splitOutput.finalContent);
              processOutput = selectPreferredTextSnapshot(processOutput, splitOutput.processContent);
              modelProcessStreaming = splitOutput.processStreaming;
            }

            syncCombinedProcessState();

            if (terminalFinalText) {
              finalOutput = selectPreferredTextSnapshot(finalOutput, finalEventText);
              emitVisiblePatchIfChanged('edit', { trimVisibleContent: true, trimVisibleProcess: true });
            }
            resetIdleTimeout();
            scheduleCompletionProbe(0);
          }
        };

        const onError = (data: { sessionKey: string; runId: string; error: string }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            pendingErrorDetail = (data.error || '').trim() || 'Unknown stream error';
            resetIdleTimeout();
            scheduleCompletionProbe(0);
          }
        };

        const onAborted = (data: { sessionKey: string; runId: string; text: string; message: any }) => {
          if (data.sessionKey === finalSessionKey && data.runId === runId) {
            if (data.text) {
              rawOutput = selectPreferredTextSnapshot(rawOutput, data.text);
              const splitOutput = splitGroupProcessOutput(rawOutput, processStartTag, processEndTag);
              finalOutput = selectPreferredTextSnapshot(finalOutput, splitOutput.finalContent);
              processOutput = selectPreferredTextSnapshot(processOutput, splitOutput.processContent);
              modelProcessStreaming = splitOutput.processStreaming;
              emitVisiblePatchIfChanged('delta', { trimVisibleContent: false, trimVisibleProcess: false });
            }
            scheduleCompletionProbe(0);
          }
        };

        const onSessionTool = (payload: {
          sessionKey?: string;
          parentSessionKey?: string;
          runId?: string;
          data?: any;
        }) => {
          if (!isRelevantToolEvent(payload)) {
            return;
          }

          const eventData = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
            ? payload.data as Record<string, unknown>
            : {};
          const toolName = typeof eventData.name === 'string' && eventData.name.trim()
            ? eventData.name.trim()
            : 'tool';
          const toolCallId = typeof eventData.toolCallId === 'string' && eventData.toolCallId.trim()
            ? eventData.toolCallId.trim()
            : `${payload.runId || runId}:${toolName}`;
          const phase = typeof eventData.phase === 'string' ? eventData.phase.trim() : '';
          const existingState = toolProgressById.get(toolCallId);
          const nextArgs = normalizeToolArgsRecord(eventData.args) ?? existingState?.args;
          const nextState: GroupToolProgressState = existingState ?? {
            toolName,
            args: nextArgs,
          };
          nextState.toolName = toolName;
          nextState.args = nextArgs;

          if (phase === 'start') {
            activeToolCallIds.add(toolCallId);
            appendToolProgressLine(toolProcessLines, formatToolStartProgress(progressLocale, toolName, nextArgs));
          } else if (phase === 'update') {
            activeToolCallIds.add(toolCallId);
          } else if (phase === 'result') {
            activeToolCallIds.delete(toolCallId);
            appendToolProgressLine(toolProcessLines, formatToolResultProgress(
              progressLocale,
              toolName,
              nextArgs,
              eventData.isError === true,
            ));
          }

          toolProcessOutput = toolProcessLines.join('\n');
          if (phase === 'result') {
            toolProgressById.delete(toolCallId);
          } else {
            toolProgressById.set(toolCallId, nextState);
          }

          emitVisiblePatchIfChanged('delta', { trimVisibleContent: false, trimVisibleProcess: true });
          resetIdleTimeout();
        };

        const onDisconnect = () => {
          rejectOnce(new Error('Gateway connection lost during streaming.'));
        };

        client.on('chat.delta', onDelta);
        client.on('chat.final', onFinal);
        client.on('chat.error', onError);
        client.on('chat.aborted', onAborted);
        client.on('session.tool', onSessionTool);
        client.on('disconnected', onDisconnect);
        resetIdleTimeout();
        scheduleCompletionProbe();
      });

      // Update DB with final content
      this.throwIfTurnStale(turn);
      const protectedResponse = selectPreferredTextSnapshot(
        selectPreferredTextSnapshot(finalOutput, response),
        finalEventText,
      );
      const splitProtectedResponse = splitGroupProcessOutput(protectedResponse, processStartTag, processEndTag);
      let canonicalResponse = canonicalizeAssistantWorkspaceArtifacts(splitProtectedResponse.finalContent, {
        workspacePath: runtimeContext.workspacePath,
        startedAtMs: runStartedAt,
      });
      let canonicalProcessContent = combineGroupProcessContent(
        toolProcessOutput,
        selectPreferredTextSnapshot(processOutput, splitProtectedResponse.processContent),
      );
      if (!canonicalResponse.trim()) {
        const canonicalFallbackResponse = canonicalizeAssistantWorkspaceArtifacts(splitProtectedResponse.processContent, {
          workspacePath: runtimeContext.workspacePath,
          startedAtMs: runStartedAt,
        });
        if (canonicalFallbackResponse.trim()) {
          canonicalResponse = canonicalFallbackResponse;
        }
      }
      latestProcessOutput = canonicalProcessContent;
      if (!canonicalResponse.trim() && msgId !== undefined) {
        if (isResetCommand) {
          this.db.deleteGroupMessage(msgId);
          this.emit('delete', {
            groupId,
            id: msgId,
            parent_id: parentId,
          });
          this.clearActiveRun(groupId, runId);
          finishTyping();
          return { status: 'completed', messageId: null, text: '' };
        }

        const { content: errMsg, messageCode, messageParams, rawDetail } = createAgentResponseFailedMessage(
          member.display_name,
          'No text output returned from the run.'
        );
        this.db.updateGroupMessage(msgId, errMsg, this.getAgentModel(agentId), null, canonicalProcessContent);
        this.db.updateGroupMessageSender(msgId, 'system', '系统');
        this.emit('message', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: 'system',
          sender_name: '系统',
          content: errMsg,
          process_content: rewriteVisibleFileLinks(canonicalProcessContent, { workspacePath: runtimeContext.workspacePath }),
          process_streaming: false,
          messageCode,
          messageParams,
          rawDetail,
          created_at: new Date().toISOString(),
        });
        this.clearActiveRun(groupId, runId);
        finishTyping();
        return { status: 'failed', messageId: msgId, text: '', error: 'No text output returned from the run.' };
      }

      if (msgId === undefined) {
        this.clearActiveRun(groupId, runId);
        finishTyping();
        return { status: 'failed', messageId: null, text: '', error: 'reply row missing' };
      }

      this.db.updateGroupMessage(
        msgId, 
        canonicalResponse, 
        this.getAgentModel(agentId), 
        null,
        canonicalProcessContent,
      );
      const visibleResponse = selectPreferredTextSnapshot(
        visibleFinalOutput,
        rewriteVisibleFileLinks(canonicalResponse, { workspacePath: runtimeContext.workspacePath }).trim(),
      );
      const visibleProcessResponse = selectPreferredTextSnapshot(
        visibleProcessOutput,
        rewriteVisibleFileLinks(canonicalProcessContent, { workspacePath: runtimeContext.workspacePath }).trim(),
      );
      if (visibleResponse !== visibleFinalOutput || visibleProcessResponse !== visibleProcessOutput) {
        visibleFinalOutput = visibleResponse;
        visibleProcessOutput = visibleProcessResponse;
        this.emit('edit', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: agentId,
          sender_name: member.display_name,
          content: visibleResponse,
          process_content: visibleProcessResponse,
          process_streaming: false,
          model_used: modelUsed,
          created_at: placeholderCreatedAt,
        });
      }
      this.clearActiveRun(groupId, runId);
      finishTyping();

      // 转交（@ 了别人）不在这里做：结果交回编排器，由它按服务端签发的深度与发起人授权统一路由。
      return { status: 'completed', messageId: msgId, text: canonicalResponse };
    } catch (err: any) {
      if (err instanceof GroupResetInterruptedError || !this.isTurnCurrent(turn)) {
        return { status: 'reset', messageId: null, text: '' };
      }

      if (activeRunId) {
        this.clearActiveRun(groupId, activeRunId);
      }
      finishTyping();
      console.error(`[GroupChatEngine] runGatewayMember Error. Group: ${groupId}, Agent: ${agentId}`, err);
      const rawDetail = typeof err?.rawDetail === 'string'
        ? err.rawDetail
        : (typeof err?.message === 'string' ? err.message : '');
      const messageCode = err instanceof AudioPreparationError
        ? err.messageCode
        : undefined;
      const messageParams = messageCode ? undefined : { agentName: member.display_name };
      const errMsg = messageCode
        ? (rawDetail || messageCode)
        : createAgentResponseFailedMessage(member.display_name, rawDetail).content;
      
      if (msgId !== undefined) {
        this.db.updateGroupMessage(msgId, errMsg, this.getAgentModel(agentId), null, latestProcessOutput);
        this.db.updateGroupMessageSender(msgId, 'system', '系统');
        this.emit('message', {
          groupId,
          id: msgId,
          parent_id: parentId,
          sender_type: 'agent',
          sender_id: 'system',
          sender_name: '系统',
          content: errMsg,
          process_content: rewriteVisibleFileLinks(latestProcessOutput, { workspacePath: runtimeWorkspacePath }),
          process_streaming: false,
          messageCode: messageCode || AGENT_RESPONSE_FAILED_MESSAGE_CODE,
          messageParams,
          rawDetail,
          created_at: new Date().toISOString(),
        });
      }
      return { status: 'failed', messageId: msgId ?? null, text: '', error: rawDetail || 'agent response failed' };
    } finally {
      if (sessionEventsSubscribed && sessionEventsClient) {
        sessionEventsSubscribed = false;
        try {
          await sessionEventsClient.unsubscribeSessionEvents();
        } catch (error) {
          console.warn(`[GroupChatEngine] Failed to unsubscribe session events for group ${groupId}, agent ${agentId}:`, error);
        }
      }
      if (activeRunId) {
        this.clearActiveRun(groupId, activeRunId);
      }
      if (msgId !== undefined) {
        this.clearPendingRun(groupId, msgId);
      }
      finishTyping();
    }
  }
}

export default GroupChatEngine;
