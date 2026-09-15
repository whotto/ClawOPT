import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  createClaudeCodeRuntimeAdapter,
  runExternalAgent,
  type CommandExecutor,
  type RunCoordinator,
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
} from '../sessions';
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
import { getGroupRuntimeSessionKey } from './group-workspace';
import { selectPreferredTextSnapshot } from '../sessions';
import { canonicalizeAssistantWorkspaceArtifacts } from '../../workspace';
import { shouldUseConfiguredImageGenerationModel } from '../../control';

const DEFAULT_MAX_CHAIN_DEPTH = 6;
const GROUP_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const GROUP_STREAM_COMPLETION_PROBE_DELAY_MS = 1200;
const GROUP_STREAM_COMPLETION_WAIT_TIMEOUT_MS = 1500;
const GROUP_HISTORY_COMPLETION_PROBE_LIMIT = 60;
const GROUP_HISTORY_COMPLETION_SETTLE_TIMEOUT_MS = 30000;
const GROUP_HISTORY_COMPLETION_SETTLE_POLL_MS = 500;
const GROUP_FINAL_EVENT_SETTLE_GRACE_MS = 1500;
const GROUP_EMPTY_COMPLETION_RETRY_WINDOW_MS = 5 * 60 * 1000;
const GROUP_HISTORY_ACTIVITY_GRACE_MS = 2 * 60 * 1000;
const GROUP_CONTEXT_MESSAGE_MAX_CHARS = 900;
const GROUP_CONTEXT_MESSAGE_HEAD_CHARS = 380;
const GROUP_CONTEXT_MESSAGE_TAIL_CHARS = 380;
const GROUP_CONTEXT_RECENT_WINDOW = 15;
// 历史窗口除了「最多 15 条」再加一道字符预算：15 条 × 900 字的摘要在长对话里
// 每一跳都是 1.3 万字起，且原样进网关会话累积。预算按新→旧挑，至少保 1 条。
const GROUP_CONTEXT_BUDGET_CHARS = 9000;
// 「最新任务」原先不设上限：上一位成员 2 万字的回复会整段转交，而同一段
// 又以 900 字摘要出现在历史里。这里保头保尾，中间省略并说明。
const GROUP_TRIGGER_MAX_CHARS = 6000;
const GROUP_TRIGGER_HEAD_CHARS = 4000;
const GROUP_TRIGGER_TAIL_CHARS = 1600;
const GROUP_CONTEXT_EVIDENCE_LINE_PATTERN = /(`|https?:\/\/|\/|\\|\.|已执行|执行|启动|运行|浏览器|监听|地址|端口|日志|结果|存在|生成|导出|输出|完成|成功|失败|校验|验证|测试|created|running|started|output|result|verified|browser|url|path|port|listen)/i;
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

function truncateGroupContextMessage(content: string): string {
  const normalizedContent = normalizeGroupPromptText(content);
  if (normalizedContent.length <= GROUP_CONTEXT_MESSAGE_MAX_CHARS) {
    return normalizedContent;
  }

  const head = normalizedContent.slice(0, GROUP_CONTEXT_MESSAGE_HEAD_CHARS).trimEnd();
  const tail = normalizedContent.slice(-GROUP_CONTEXT_MESSAGE_TAIL_CHARS).trimStart();
  return `${head}\n...(中间省略)...\n${tail}`.trim();
}

function summarizeGroupProcessEvidence(content: string): string {
  const normalizedContent = normalizeGroupPromptText(content);
  if (!normalizedContent) return '';

  const rawLines = normalizedContent
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (rawLines.length === 0) return '';

  const evidenceLines = rawLines.filter(line => GROUP_CONTEXT_EVIDENCE_LINE_PATTERN.test(line));
  const prioritizedLines = evidenceLines.length > 0 ? evidenceLines : rawLines;
  return truncateGroupContextMessage(prioritizedLines.join('\n'));
}

function buildGroupContextMessageSummary(
  content: string,
  processStartTag?: string,
  processEndTag?: string,
  processContentText?: string | null,
): string {
  const normalizedContent = normalizeGroupPromptText(content);
  const normalizedProcessContent = normalizeGroupPromptText(processContentText || '');

  if (normalizedProcessContent) {
    const processEvidenceSummary = summarizeGroupProcessEvidence(normalizedProcessContent);

    if (normalizedContent && processEvidenceSummary) {
      return truncateGroupContextMessage(
        `${normalizedContent}\n\n[过程证据摘要]\n${processEvidenceSummary}`,
      );
    }

    if (normalizedContent) {
      return truncateGroupContextMessage(normalizedContent);
    }

    if (processEvidenceSummary) {
      return processEvidenceSummary;
    }
  }

  if (!normalizedContent) return '';

  const startTag = processStartTag?.trim();
  const endTag = processEndTag?.trim();
  if (!startTag || !endTag) {
    return truncateGroupContextMessage(normalizedContent);
  }

  const processRegex = new RegExp(
    `${escapeRegExpForPrompt(startTag)}([\\s\\S]*?)(?:${escapeRegExpForPrompt(endTag)}|$)`,
    'g',
  );
  const outsideProcessContent = normalizeGroupPromptText(normalizedContent.replace(processRegex, '\n\n'));
  const extractedProcessContent = Array.from(normalizedContent.matchAll(processRegex))
    .map(match => normalizeGroupPromptText(match[1] || ''))
    .filter(Boolean)
    .join('\n\n');
  const processEvidenceSummary = summarizeGroupProcessEvidence(extractedProcessContent);

  if (outsideProcessContent && processEvidenceSummary) {
    return truncateGroupContextMessage(
      `${outsideProcessContent}\n\n[过程证据摘要]\n${processEvidenceSummary}`,
    );
  }

  if (outsideProcessContent) {
    return truncateGroupContextMessage(outsideProcessContent);
  }

  if (processEvidenceSummary) {
    return processEvidenceSummary;
  }

  return truncateGroupContextMessage(normalizedContent);
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

function createMaxChainDepthMessage(maxDepth: number): Required<StructuredGroupMessage> & { content: string } {
  return {
    content: `链式转发已达到最大深度 (${maxDepth} 轮)`,
    messageCode: MAX_CHAIN_DEPTH_MESSAGE_CODE,
    messageParams: { maxDepth },
    rawDetail: '',
    forceSystemMessage: true,
  };
}

// 链式转发设为 0 时成员仍 @ 了别人：原先静默吞掉，用户只看到链条停了、不知道为什么。
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

function createChainForwardingDisabledMessage(agentName: string): Required<StructuredGroupMessage> & { content: string } {
  return {
    content: `链式转发已关闭，未转交给 ${agentName}`,
    messageCode: CHAIN_FORWARDING_DISABLED_MESSAGE_CODE,
    messageParams: { agentName },
    rawDetail: '',
    forceSystemMessage: true,
  };
}

/**
 * 从最近的群消息里挑进提示词的历史窗口：新→旧，受条数与字符预算双重约束。
 * 触发消息本身（parentId 指向的那条）若与「最新任务」内容一致则不重复放进历史。
 */
export function selectGroupContextWindow(
  rows: GroupMessageRow[],
  options: {
    triggerParentId?: number | null;
    triggerMsg?: string;
    triggerSenderName?: string;
    maxRows?: number;
    budgetChars?: number;
  } = {},
): GroupMessageRow[] {
  const maxRows = options.maxRows ?? GROUP_CONTEXT_RECENT_WINDOW;
  const budget = options.budgetChars ?? GROUP_CONTEXT_BUDGET_CHARS;
  const trigger = (options.triggerMsg || '').trim();
  const picked: GroupMessageRow[] = [];
  let used = 0;

  for (let index = rows.length - 1; index >= 0 && picked.length < maxRows; index -= 1) {
    const row = rows[index];
    const isTriggerRow = options.triggerParentId != null
      && row.id === options.triggerParentId
      && (
        (trigger !== '' && row.content.trim() === trigger)
        || (options.triggerSenderName !== undefined && row.sender_type === 'agent' && row.sender_name === options.triggerSenderName)
        || (row.sender_type === 'user' && trigger !== '' && row.content.trim() === trigger)
      );
    if (isTriggerRow) continue;

    const bodyChars = Math.min(
      row.content.length + (row.process_content?.length ?? 0),
      GROUP_CONTEXT_MESSAGE_MAX_CHARS + 64,
    );
    const cost = bodyChars + (row.sender_name?.length ?? 2) + 4;
    if (picked.length > 0 && used + cost > budget) break;
    picked.unshift(row);
    used += cost;
  }

  return picked;
}

export function truncateGroupTriggerMessage(triggerMsg: string): string {
  if (triggerMsg.length <= GROUP_TRIGGER_MAX_CHARS) return triggerMsg;
  const omitted = triggerMsg.length - GROUP_TRIGGER_HEAD_CHARS - GROUP_TRIGGER_TAIL_CHARS;
  return `${triggerMsg.slice(0, GROUP_TRIGGER_HEAD_CHARS)}\n\n…（中间省略 ${omitted} 字，全文已作为上一条消息保存在团队对话里）…\n\n${triggerMsg.slice(-GROUP_TRIGGER_TAIL_CHARS)}`;
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
 * GroupChatEngine handles message routing in group chats.
 * 
 * Improvements inspired by OpenCrew:
 * - Structured agent prompts (Objective / Context / Boundaries)
 * - WAIT discipline: agents do one step then wait
 * - Better anti-loop: per-group maxTurns + self-mention prevention
 */
export class GroupChatEngine extends EventEmitter {
  private db: DB;
  private getClient: (sessionId: string) => Promise<OpenClawClient>;
  private getAgentModel: (agentId: string) => string;
  private getPreferredLanguage: () => GroupToolProgressLocale;
  private processingGroups = new Set<string>();
  private resetEpochs = new Map<string, number>();
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
  /** 外部成员的运行由协调器驱动（room-engine.ts 组装时注入）。 */
  private runCoordinator: RunCoordinator | null = null;

  useRunCoordinator(coordinator: RunCoordinator): void {
    this.runCoordinator = coordinator;
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
   * 每个群当前持锁的起始时间。
   *
   * 锁本身在 finally 里释放，不会因抛错泄漏——真正会卡死的是
   * dispatchExistingUserMessage 一直 await 不返回（文档工具首次 bootstrap
   * 最长 20 分钟、转写、生图都在这条链上，全程没有超时）。此时 finally 没执行，
   * 群就一直锁着，之后每条消息都吃 409 且无从自救。
   *
   * 这里不强杀正在跑的任务（它可能真的只是慢，杀掉会让用户丢掉已经产生的回复），
   * 而是记录持锁时长：超过阈值后允许新一轮抢占，并在日志里留痕。
   */
  private processingSince = new Map<string, number>();

  /**
   * 每成员一把锁，键是 (群, 成员)。
   *
   * 原来整轮派发握着群锁：一个 Claude Code 跑 10 分钟，整个群 10 分钟不能说话。
   * 外部 Agent 的典型时长就是分钟级，而「多 Agent 协作」的前提是别人还能说话——
   * 所以 per-member 是结论，不是选项。
   *
   * 陈旧阈值沿用群锁那一套（15 分钟）：外部子进程跑飞时，成员不能永远锁死。
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

  /** 超过这个时长仍未释放，视为卡死，允许新消息抢占。 */
  private static readonly STALE_LOCK_MS = 15 * 60 * 1000;

  /** 持锁是否已经陈旧到可以被抢占。 */
  private isGroupLockStale(groupId: string): boolean {
    const since = this.processingSince.get(groupId);
    if (since === undefined) return false;
    return Date.now() - since > GroupChatEngine.STALE_LOCK_MS;
  }

  /** 已经持锁多久（分钟），用于给用户一个能判断的数字。 */
  groupLockAgeMinutes(groupId: string): number | null {
    const since = this.processingSince.get(groupId);
    if (since === undefined) return null;
    return Math.floor((Date.now() - since) / 60000);
  }

  private emitRunState(groupId: string) {
    const activeRun = this.activeRuns.get(groupId);
    const pendingRun = this.pendingRuns.get(groupId);
    const currentRun = activeRun || pendingRun;
    this.emit('run_state', {
      groupId,
      active: this.processingGroups.has(groupId) || this.hasBusyMember(groupId) || !!currentRun,
      agentId: currentRun?.agentId || null,
      runId: activeRun?.runId || null,
      startedAt: currentRun?.startedAt || null,
    });
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

  private getResetEpoch(groupId: string): number {
    return this.resetEpochs.get(groupId) ?? 0;
  }

  private throwIfGroupReset(groupId: string, expectedEpoch: number): void {
    if (this.getResetEpoch(groupId) !== expectedEpoch) {
      throw new GroupResetInterruptedError(groupId);
    }
  }

  markGroupReset(groupId: string): number {
    const nextEpoch = this.getResetEpoch(groupId) + 1;
    this.resetEpochs.set(groupId, nextEpoch);
    return nextEpoch;
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

    this.processingGroups.delete(groupId);
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
      active: this.processingGroups.has(groupId) || this.hasBusyMember(groupId) || !!currentRun,
      agentId: currentRun?.agentId || null,
      runId: activeRun?.runId || null,
      startedAt: currentRun?.startedAt || null,
    };
  }

  /** 「群里还有事在跑吗」——给展示层与重新生成用，**包含**成员锁。 */
  isGroupProcessing(groupId: string) {
    return this.processingGroups.has(groupId) || this.hasBusyMember(groupId)
      || this.pendingRuns.has(groupId) || this.activeRuns.has(groupId);
  }

  /**
   * 「现在能不能接一条新消息」——**不包含**成员锁，这是它与上面那条的全部区别。
   *
   * 一个外部成员跑 10 分钟不该让整个群说不了话，那正是 per-member 锁的目的；
   * 用 `isGroupProcessing()` 来挡新消息，会在 HTTP 层把那个目的整个抵消掉
   * （这个错我犯过：锁改完了，路由没改，于是锁在生产上空转）。
   *
   * 但也不能全放开：`activeRuns` / `pendingRuns` 是**按 groupId 键**的，
   * 网关那条路上整套会话对账都挂在「一个群同时只有一次运行」这个假设上。
   * 放两轮网关运行并发进去，等于让它们并发写同一份从没为并发设计过的状态。
   *
   * 所以判据是：群级独占（重新生成）与网关运行仍然挡；**纯外部成员在忙不挡**
   * ——外部路径不碰 activeRuns，对它开放是安全的。
   *
   * 等网关路径的运行跟踪也改成按成员键之后，这两条判据才能合并。
   */
  isGroupBlockingNewMessage(groupId: string) {
    return this.processingGroups.has(groupId)
      || this.pendingRuns.has(groupId) || this.activeRuns.has(groupId);
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

  private resolveMemberDisplayName(member: GroupMemberRow): string {
    const linkedSession = this.db.getSessionByAgentId(member.agent_id) || this.db.getSession(member.agent_id);
    const latestName = linkedSession?.name?.trim();
    return latestName || member.display_name;
  }

  private resolveMembers(members: GroupMemberRow[]): GroupMemberRow[] {
    return members.map((member) => {
      const latestName = this.resolveMemberDisplayName(member);
      return latestName === member.display_name ? member : { ...member, display_name: latestName };
    });
  }

  private resolveGroupParentId(groupId: string, _requestedParentId?: number): number | undefined {
    // Group chats are strictly linear. Always attach new messages to the latest
    // persisted group message instead of honoring any older valid parent id.
    return this.db.getLatestGroupMessageId(groupId);
  }

  /**
   * Parse @mentions from message content.
   * Returns array of matching member agentIds.
   */
  parseMentions(content: string, members: GroupMemberRow[]): string[] {
    const mentioned: string[] = [];
    
    // Check for @all
    if (/@all\b/i.test(content)) {
      return members.map(m => m.agent_id);
    }

    for (const member of members) {
      // Match @displayName (e.g. @产品经理, @程序员)
      const escaped = member.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`@${escaped}(?:\\s|$|[，。！？,.]|$)`, 'i');
      if (regex.test(content)) {
        mentioned.push(member.agent_id);
      }
    }

    return [...new Set(mentioned)];
  }

  private saveSystemNotice(
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
   * `sender_id`（`ext:<runtime>:<agentId>`）——后者会从三个地方回传进来：
   * 不带 @ 时的「回复上一个发言者」、重新生成、运行恢复。
   *
   * 不认第二种写法的后果不是报错，是 `sendToAgent` 里 `find` 落空后静默
   * `return parentId`：用户追问一句，群里毫无反应。
   *
   * 判据只实现一次，放在这里，三个调用点都经过 `sendToAgent` 自然享受到。
   */
  resolveMemberByAgentRef(members: GroupMemberRow[], ref: string): GroupMemberRow | undefined {
    const direct = members.find((m) => m.agent_id === ref);
    if (direct) return direct;

    const parsed = parseExternalSenderId(ref);
    if (!parsed) return undefined;
    // 运行时也要对上：同名 agentId 换了运行时就是另一回事。
    return members.find((m) => m.agent_id === parsed.agentId && (m.runtime || 'openclaw') === parsed.runtime);
  }

  private resolveTargetAgentIds(groupId: string, content: string, members: GroupMemberRow[]): string[] {
    let targetAgentIds = this.parseMentions(content, members);

    if (content.trim() === '/new') {
      return members.map((member) => member.agent_id);
    }

    if (targetAgentIds.length === 0) {
      const recent = this.db.getRecentGroupMessages(groupId, 5);
      const lastAgent = [...recent].reverse().find((message) => (
        message.sender_type === 'agent'
        && message.sender_id !== 'system'
      ));
      if (lastAgent?.sender_id) {
        targetAgentIds = [lastAgent.sender_id];
      } else {
        targetAgentIds = [members[0].agent_id];
      }
    }

    return targetAgentIds;
  }

  private async dispatchExistingUserMessage(
    groupId: string,
    groupName: string,
    content: string,
    members: GroupMemberRow[],
    userMsgId: number,
    resetEpoch: number,
  ): Promise<void> {
    const targetAgentIds = this.resolveTargetAgentIds(groupId, content, members);
    let currentParentId: number | undefined = userMsgId;

    for (const agentId of targetAgentIds) {
      this.throwIfGroupReset(groupId, resetEpoch);
      const res = await this.sendToAgent(groupId, groupName, agentId, content, '用户', 0, currentParentId, resetEpoch);
      if (res !== undefined) currentParentId = res;
    }
  }

  /**
   * Build a structured prompt for an agent (inspired by OpenCrew's Subagent Packet).
   * Includes: role identity, group context, recent messages, task, and boundaries.
   */
  buildAgentPrompt(
    groupName: string,
    groupDesc: string,
    member: GroupMemberRow,
    allMembers: GroupMemberRow[],
    recentMessages: GroupMessageRow[], 
    triggerMsg: string,
    triggerSenderName: string,
    processStartTag?: string,
    processEndTag?: string,
    workspacePath?: string,
    uploadsPath?: string,
    outputPath?: string,
    remainingDepth: number = 0
  ): string {
    // Build recent message context (last 15 messages, truncated)
    const contextLines = recentMessages.map(m => {
      const name = m.sender_type === 'user' ? '用户' : (m.sender_name || '未知');
      const normalizedContent = uploadsPath
        ? rewriteMessageWithWorkspaceUploads(m.content, uploadsPath, { extractImageAttachments: false }).text
        : m.content;
      const normalizedProcessContent = uploadsPath
        ? rewriteMessageWithWorkspaceUploads(m.process_content || '', uploadsPath, { extractImageAttachments: false }).text
        : (m.process_content || '');
      const summary = buildGroupContextMessageSummary(normalizedContent, processStartTag, processEndTag, normalizedProcessContent);
      return `[${name}]: ${summary}`;
    }).join('\n');

    // Build the dynamic contextual prompt
    // Format instructions FIRST for maximum priority
    const parts: string[] = [];
    const hasProcessTags = !!(processStartTag && processEndTag);

    // 0. FORMAT INSTRUCTIONS (FIRST - highest priority)
    let formatHeader = `=== 系统强制规定（最高优先级，必须遵守）===\n`;
    let ruleIdx = 1;

    if (hasProcessTags) {
      formatHeader += `规则${ruleIdx++}: 【工作记录汇报】在回复中，用以下标签包裹你的实际执行步骤、操作记录和中间结果（就像团队成员汇报工作进度一样）：\n${processStartTag}\n（在这里写你做了什么、执行了哪些操作、看到了什么结果）\n${processEndTag}\n标签外面写最终结论或给人的回复。这是团队协作的标准汇报格式，必须遵守！\n`;
      formatHeader += `规则${ruleIdx++}: 【实时更新处理过程】一开始动手就立刻输出 ${processStartTag}，并随着你的实际工作持续追加简短进度，比如“正在打开 xxx 文件”“正在修改 xxx 文件”“已完成搜索”。每次只写一句高信号进展，不要逐字粘贴大段命令输出、网页原文或重复日志；除非出错，只保留关键动作、关键结果、关键结论。不要等全部做完后再一次性回顾总结。完成工作记录后，再输出 ${processEndTag}，最后在标签外给出结论。\n`;
    }

    formatHeader += `规则${ruleIdx++}: 【以上下文为准】如果你之前的记忆、你自己更早的回复、或 OpenClaw 历史记忆，与下面提供的“团队对话历史 / 最新任务”冲突，必须以下面提供的内容为准，并明确纠正旧结论，不能抱着旧判断不放。\n`;

    if (remainingDepth === 0) {
      formatHeader += `规则${ruleIdx++}: 【禁止@他人】严禁在回复中出现 "@任何人" 的内容。必须独立完成任务，直接给出结论。\n`;
    } else {
      const otherMembers = allMembers.filter(m => m.agent_id !== member.agent_id).map(m => m.display_name);
      if (otherMembers.length > 0) {
        formatHeader += `规则${ruleIdx++}: 【可选转交】若需他人继续处理，可在回复末尾加 "@姓名"（可用: ${otherMembers.join(', ')}）。若已完成则不加。\n`;
      }
    }

    formatHeader += `=== 规定结束 ===`;
    parts.push(formatHeader);

    // 1. Group-level system prompt
    if (groupDesc && groupDesc.trim() !== '') {
      parts.push(groupDesc);
    }

    if (this.canUseHostTakeover(member.agent_id)) {
      parts.push(buildGroupHostTakeoverPrompt());
    }

    if (workspacePath && uploadsPath && outputPath) {
      parts.push(
        `团队工作区:\n`
        + `- 根目录: ${workspacePath}\n`
        + `- 上传目录: ${uploadsPath}\n`
        + `- 输出目录: ${outputPath}\n`
        + `- 新生成的项目目录请创建在团队工作区根目录下，不要写入成员个人 workspace。`
      );
    }
    
    // 2. Member-level role
    if (member.role_description && member.role_description.trim() !== '') {
      parts.push(`当前身份: ${member.display_name}\n${member.role_description}`);
    } else {
      parts.push(`当前身份: ${member.display_name}`);
    }

    // 3. Chat context
    if (contextLines) {
      parts.push(`团队对话历史:\n${contextLines}`);
    }

    // 4. Trigger message
    parts.push(`最新任务 (${triggerSenderName}):\n${truncateGroupTriggerMessage(triggerMsg)}`);

    // 5. End reminder
    if (hasProcessTags) {
      parts.push(`[汇报格式提醒] 请用 ${processStartTag}...${processEndTag} 记录你的操作步骤和执行结果，再在标签外写对话结论。过程只保留高信号短句，不要贴大段原始输出。`);
    }

    const finalPrompt = parts.join('\n\n');
    console.log(`[GroupChat][Prompt] agent=${member.display_name} hasProcessTags=${hasProcessTags} depth=${remainingDepth}\n${finalPrompt.slice(0, 600)}`);
    return finalPrompt;
  }

  /**
   * Send a user message to the group chat, route to agents.
   */
  async sendUserMessage(groupId: string, content: string, specifiedParentId?: number): Promise<void> {
    // **这里不再握整轮群锁。**
    //
    // 原来整轮派发都握着它：一个 Claude Code 跑 10 分钟，整个群 10 分钟不能说话，
    // 第二条消息直接吃 409。而「多 Agent 协作」的前提就是别人还能说话——
    // 所以并发控制下沉到 sendToAgent 里的每成员一把锁。
    //
    // 下面「算 parent → 落库 → 广播」那一段全是同步调用，Node 单线程下本来就原子，
    // 不需要锁来保护；群锁真正挡住的是整轮派发，而那正是不该挡的东西。
    //
    // 重新生成（rerunUserMessage）仍然走群锁——v1.5.2 明确要求过，它重写的是
    // 已有消息的分支，和追加一条新消息不是一回事。
    const resetEpoch = this.getResetEpoch(groupId);
    this.emitRunState(groupId);

    try {
      this.throwIfGroupReset(groupId, resetEpoch);
      const group = this.db.getGroupChat(groupId);
      if (!group) throw new Error('团队不存在');

      this.throwIfGroupReset(groupId, resetEpoch);
      const members = this.resolveMembers(this.db.getGroupMembers(groupId));
      if (members.length === 0) throw new Error('团队没有成员');

      // Always keep group chats linear: if the requested parent is stale, fall back to the latest existing message.
      const computedParentId = this.resolveGroupParentId(groupId, specifiedParentId);

      // Save user message
      const userMsgId = this.db.saveGroupMessage({
        group_id: groupId,
        parent_id: computedParentId,
        sender_type: 'user',
        sender_name: '用户',
        content,
      });

      this.emit('message', { groupId, id: userMsgId, parent_id: computedParentId, sender_type: 'user', sender_name: '用户', content, created_at: new Date().toISOString() });
      await this.dispatchExistingUserMessage(groupId, group.name, content, members, userMsgId, resetEpoch);
    } catch (error) {
      if (!(error instanceof GroupResetInterruptedError)) {
        throw error;
      }
    } finally {
      this.emitRunState(groupId);
    }
  }

  async rerunUserMessage(groupId: string, userMessageId: number): Promise<void> {
    if (this.processingGroups.has(groupId)) {
      if (!this.isGroupLockStale(groupId)) {
        const error = new Error('Group run already in progress.');
        (error as Error & { code?: string }).code = 'GROUP_RUN_IN_PROGRESS';
        throw error;
      }
      // 卡了太久：放行新一轮，否则这个群只能靠 /stop 才能恢复。
      console.warn(`[GroupChat] 群 ${groupId} 的运行锁已持有 ${this.groupLockAgeMinutes(groupId)} 分钟，判定为卡死并允许新一轮开始`);
      this.processingGroups.delete(groupId);
      this.processingSince.delete(groupId);
    }

    const resetEpoch = this.getResetEpoch(groupId);
    this.processingGroups.add(groupId);
    this.processingSince.set(groupId, Date.now());
    this.emitRunState(groupId);

    try {
      this.throwIfGroupReset(groupId, resetEpoch);
      const group = this.db.getGroupChat(groupId);
      if (!group) throw new Error('团队不存在');

      this.throwIfGroupReset(groupId, resetEpoch);
      const members = this.resolveMembers(this.db.getGroupMembers(groupId));
      if (members.length === 0) throw new Error('团队没有成员');

      const userMessage = this.db.getGroupMessageById(userMessageId, groupId);
      if (!userMessage || userMessage.sender_type !== 'user') {
        throw new Error('Only user messages can be rerun.');
      }

      const latestMessageId = this.db.getLatestGroupMessageId(groupId);
      if (latestMessageId !== userMessageId) {
        throw new Error('Only the latest user message can be rerun.');
      }

      await this.dispatchExistingUserMessage(
        groupId,
        group.name,
        userMessage.content,
        members,
        userMessageId,
        resetEpoch,
      );
    } catch (error) {
      if (!(error instanceof GroupResetInterruptedError)) {
        throw error;
      }
    } finally {
      this.processingGroups.delete(groupId);
      this.processingSince.delete(groupId);
      this.emitRunState(groupId);
    }
  }

  /**
   * Send a message to a specific agent and handle chain forwarding.
   * Anti-loop protection:
   *   1. Max chain depth (default 6, configurable per group)
   *   2. No self-mention forwarding
   *   3. Relaxed A->B->A to allow iterative multi-agent tasks (like Coder<=>Tester loops)
   */
  /**
   * 外部运行时成员的派发路径。
   *
   * **它和网关那条路完全分开。** 网关那条上有整套会话对账、文本快照保护、
   * 工具进度 i18n，全是从事故里长出来的；为了加一个分支去动它，风险远大于收益。
   *
   * 会话只在成功时落库：实测 `--resume` 指向不存在的会话会失败退出
   * （No conversation found with session ID），所以失败的那一轮若把 uuid 写进去，
   * 之后每一轮都会拿着一个死会话去 resume，永久失败。
   */
  private async runExternalMember(
    opts: {
      groupId: string;
      groupName: string;
      member: GroupMemberRow;
      allMembers: GroupMemberRow[];
      triggerMsg: string;
      triggerSenderName: string;
      depth: number;
      parentId?: number;
      resetEpoch?: number;
      remainingDepth?: number;
    },
    runner: CommandExecutor = runExternalAgent,
  ): Promise<number | undefined> {
    const { groupId, groupName, member, allMembers, triggerMsg, triggerSenderName, depth, parentId } = opts;
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
    const msgId = this.db.saveGroupMessage({
      group_id: groupId,
      parent_id: parentId,
      sender_type: 'agent',
      sender_id: senderId,
      sender_name: member.display_name,
      content: '',
      process_content: '',
      model_used: config.model || runtime,
      created_at: createdAt,
    });

    const basePayload = {
      groupId,
      id: msgId,
      parent_id: parentId,
      sender_type: 'agent' as const,
      sender_id: senderId,
      sender_name: member.display_name,
      model_used: config.model || runtime,
      created_at: createdAt,
    };
    this.emit('message', { ...basePayload, content: '', process_content: '', process_streaming: false });
    this.emit('typing', { groupId, agentId: member.agent_id, displayName: member.display_name });

    // 复用网关那条路的 prompt 组装：团队名册、群设定、最近历史、@ 协议、剩余深度
    // 全在里面。此前这里只有一行 `${发言人}：${内容}`——外部成员既不知道群里有谁，
    // 也看不见上文，**就算想 @ 别人也不知道该 @ 谁**。
    //
    // 不另写一套：两套 prompt 组装迟早分家，而这个仓库为「两处判据分家」栽过不止一次。
    // 过程标签传 undefined —— 外部 Agent 不产出过程标签，不该被要求去写。
    const request = {
      sessionId,
      resume,
      prompt: this.buildAgentPrompt(
        groupName,
        this.db.getGroupChat(groupId)?.system_prompt || '',
        member,
        allMembers,
        selectGroupContextWindow(
          this.db.getGroupMessages(groupId, 100).filter((m) => m.id !== msgId),
          { triggerParentId: parentId, triggerMsg, triggerSenderName },
        ),
        triggerMsg,
        triggerSenderName,
        undefined,
        undefined,
        config.workingDir,
        undefined,
        undefined,
        opts.remainingDepth ?? 0,
      ),
      workingDir: config.workingDir || process.cwd(),
      model: config.model,
      allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools : undefined,
      maxBudgetUsd: typeof config.maxBudgetUsd === 'number' ? config.maxBudgetUsd : undefined,
      appendSystemPrompt: config.appendSystemPrompt,
    };

    try {
      // 运行交给协调器：会话行、run marker、陈旧事件、中止、用量去重、工具调用落库、终态顺序都在那里。
      // 这里只剩外部成员自己的约定：消息行（投影器）、续话会话（external_sessions）、链式转发。
      // 成员锁仍在 sendToAgent 里取；协调器按 (群, 成员) 会话键再挡一次并发。
      const modelTag = config.model || runtime;
      const submitted = await this.requireRunCoordinator().submit({
        sessionKey: externalMemberSessionKey(groupId, member.id),
        surface: 'room',
        topics: [roomTopic(groupId), agentTopic(senderId)],
        agentId: senderId,
        title: member.display_name,
        adapter: createClaudeCodeRuntimeAdapter({ executor: runner }),
        request,
        projector: (run) => createExternalMemberProjector({
          db: this.db,
          emit: (event, payload) => this.emit(event, payload),
          run,
          basePayload,
          displayName: member.display_name,
          modelTag,
        }),
        workspacePath: config.workingDir,
        meta: { groupId, memberId: member.id, messageId: msgId },
      }, 'reject');
      if (submitted.status !== 'started') {
        const message = `${member.display_name} 执行失败（busy）`;
        this.db.updateGroupMessage(msgId, message, modelTag, undefined, '');
        this.emit('edit', { ...basePayload, content: message, process_content: '', process_streaming: false });
        return msgId;
      }
      const { outcome, projection } = await submitted.completion;

      if (outcome.kind === 'completed') {
        const finalText = projection.output ?? '';
        // 只有成功才把会话记下来。
        this.db.setExternalSession(groupId, member.id, sessionId);

        // 链式转发：外部成员 @ 了别人，那个人要真的被叫起来。
        // 此前这里是叶子节点——外部 Agent 说「@情报调研 帮我查一下」，那句话只作为
        // 文本停在群里，协作因此是**单向**的（OpenClaw 能转给外部，外部转不回来）。
        //
        // 走的是同一个 sendToAgent，所以它在里面按 runtime 分岔、重新查 max_chain_depth、
        // 重新拿成员锁——转发的语义与网关那条路完全一致，不是另一套。
        let lastMsgId = msgId;
        for (const nextAgentId of this.parseMentions(finalText, allMembers)) {
          if (nextAgentId === member.agent_id) continue;   // 不转给自己
          const next = await this.sendToAgent(
            groupId, groupName, nextAgentId, finalText, member.display_name,
            depth + 1, lastMsgId, opts.resetEpoch,
          );
          if (next !== undefined) lastMsgId = next;
        }
        return lastMsgId;
      }

      // 失败不删行，只标状态——行留着，排障才看得到「上次为什么失败」。
      // 超时分成两种记：硬超时与中断的处置本来就不同。
      const failureStatus = outcome.kind === 'aborted' ? 'cancelled'
        : outcome.stopReason === 'hard_timeout' ? 'hard_timeout'
        : 'failed';
      const detail = describeExternalFailure(outcome);
      if (resume) {
        this.db.markExternalSessionUnusable(groupId, member.id, failureStatus, detail);
      } else {
        // 首轮就失败：先把行建出来再标，否则没有行可标，那次失败不留痕迹。
        this.db.setExternalSession(groupId, member.id, sessionId);
        this.db.markExternalSessionUnusable(groupId, member.id, failureStatus, detail);
      }
    } finally {
      this.emit('typing_done', { groupId, agentId: member.agent_id });
    }

    return msgId;
  }

  public async sendToAgent(
    groupId: string,
    groupName: string,
    agentId: string,
    triggerMsg: string,
    triggerSenderName: string,
    depth: number,
    parentId?: number,
    resetEpoch?: number
  ): Promise<number | undefined> {
    const effectiveResetEpoch = resetEpoch ?? this.getResetEpoch(groupId);
    this.throwIfGroupReset(groupId, effectiveResetEpoch);

    // Keep the agent reply chain attached to the latest valid message even if the incoming parent is stale.
    parentId = this.resolveGroupParentId(groupId, parentId);

    const group = this.db.getGroupChat(groupId);
    const maxDepth = group?.max_chain_depth ?? DEFAULT_MAX_CHAIN_DEPTH;

    if (maxDepth === 0 && depth > 0) {
      // 链式转发设为 0 时禁止自动转发——但要说出来，不能静默停在这里。
      const targetName = this.db.getGroupMembers(groupId).find(m => m.agent_id === agentId)?.display_name || agentId;
      return this.saveSystemNotice(groupId, parentId, createChainForwardingDisabledMessage(targetName));
    }

    if (maxDepth > 0 && depth >= maxDepth) {
      return this.saveSystemNotice(groupId, parentId, createMaxChainDepthMessage(maxDepth));
    }

    const members = this.resolveMembers(this.db.getGroupMembers(groupId));
    const member = this.resolveMemberByAgentRef(members, agentId);
    if (!member) return parentId;
    // **归一**：后面所有地方（成员锁、typing 事件、落库）都用裸 agent_id。
    // 不归一的话，`eng` 与 `ext:claude-code:eng` 会拿到两把不同的锁，
    // 「成员正忙」这条判据整个失效。
    agentId = member.agent_id;

    // 每成员一把锁。拿不到说明这个成员正在跑上一轮——**说出来**，
    // 不要静默排队，也不要像从前那样让整个群 409。
    if (!this.acquireMemberLock(groupId, agentId)) {
      return this.saveSystemNotice(groupId, parentId, createMemberBusyMessage(member.display_name));
    }

    // 外部运行时走**完全独立**的一条路，不进下面的网关流程。
    // 那条流程上有整套会话对账、文本快照保护、工具进度 i18n，全是从事故里长出来的；
    // 为了加一个分支去改它，风险远大于收益。
    if ((member.runtime || 'openclaw') !== 'openclaw') {
      try {
        return await this.runExternalMember({
          groupId, groupName, member, allMembers: members,
          triggerMsg, triggerSenderName, depth, parentId,
          resetEpoch: effectiveResetEpoch,
          remainingDepth: maxDepth === 0 ? 0 : Math.max(0, maxDepth - depth),
        });
      } finally {
        this.releaseMemberLock(groupId, agentId);
      }
    }

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
      const groupSysPrompt = group?.system_prompt || group?.description || '';
      const runtimeContext = await this.prepareGroupRuntime(groupId, agentId);
      runtimeWorkspacePath = runtimeContext.workspacePath;
      this.throwIfGroupReset(groupId, effectiveResetEpoch);
      
      // Always replay a recent summarized history window into the prompt.
      // Relying on delta-only memory makes agents cling to stale session context after
      // edits, resets, prompt-shaping fixes, or earlier misreads, and can also drop
      // history entirely if the current placeholder message is included in the scan.
      const allRecent = this.db
        .getGroupMessages(groupId, 100)
        .filter(message => message.id !== msgId);
      const promptContextMessages = selectGroupContextWindow(allRecent, {
        triggerParentId: parentId,
        triggerMsg,
        triggerSenderName,
      });
      
      const isResetCommand = triggerMsg.trim() === '/new';
      const remainingDepth = maxDepth === 0 ? 0 : Math.max(0, maxDepth - depth);
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
      this.throwIfGroupReset(groupId, effectiveResetEpoch);
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
      this.throwIfGroupReset(groupId, effectiveResetEpoch);
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
        this.throwIfGroupReset(groupId, effectiveResetEpoch);
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
        return msgId;
      }

      const prompt = isResetCommand 
        ? triggerMsg
        : this.buildAgentPrompt(
          groupName,
          groupSysPrompt,
          member,
          members,
          promptContextMessages,
          promptInput,
          triggerSenderName,
          processStartTag,
          processEndTag,
          runtimeContext.workspacePath,
          runtimeContext.uploadsPath,
          runtimeContext.outputPath,
          remainingDepth
        );

      // Use the group's ID as the session key so it isolates memory per group
      // Tools (browser, code execution, etc.) are granted via agentId, not sessionKey.
      const sessionKey = getGroupRuntimeSessionKey(groupId, group?.runtime_session_epoch);
      const client = await this.getClient(runtimeContext.runtimeAgentId);
      sessionEventsClient = client;
      this.throwIfGroupReset(groupId, effectiveResetEpoch);
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
      this.throwIfGroupReset(groupId, effectiveResetEpoch);

      // Start streaming response
      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey,
        message: prompt,
        agentId: runtimeContext.runtimeAgentId,
        attachments: rewrittenTrigger.attachments,
      });
      if (this.getResetEpoch(groupId) !== effectiveResetEpoch) {
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
          }, GROUP_STREAM_IDLE_TIMEOUT_MS);
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
      this.throwIfGroupReset(groupId, effectiveResetEpoch);
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
      const mentionedIds = this.parseMentions(canonicalResponse, members);
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
          return parentId;
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
        return msgId;
      }

      if (msgId === undefined) {
        this.clearActiveRun(groupId, runId);
        finishTyping();
        return parentId;
      }

      this.db.updateGroupMessage(
        msgId, 
        canonicalResponse, 
        this.getAgentModel(agentId), 
        mentionedIds.length > 0 ? JSON.stringify(mentionedIds) : null,
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

      // Chain forward: if the agent's response mentions other agents
      let lastMsgId = msgId;
      if (mentionedIds.length > 0) {
        for (const nextAgentId of mentionedIds) {
          if (nextAgentId !== agentId) { // Don't send to self
            const res = await this.sendToAgent(groupId, groupName, nextAgentId, canonicalResponse, member.display_name, depth + 1, lastMsgId, effectiveResetEpoch);
            if (res !== undefined) lastMsgId = res;
          }
        }
      }
      return lastMsgId;
    } catch (err: any) {
      if (err instanceof GroupResetInterruptedError || this.getResetEpoch(groupId) !== effectiveResetEpoch) {
        return parentId;
      }

      if (activeRunId) {
        this.clearActiveRun(groupId, activeRunId);
      }
      finishTyping();
      console.error(`[GroupChatEngine] sendToAgent Error. Group: ${groupId}, Agent: ${agentId}`, err);
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
      return msgId || parentId;
    } finally {
      // 锁必须在这里放，不能在 try 的出口放——中途抛错、被 /stop 打断、
      // 上游超时都会跳过那些出口，而成员锁一旦漏放就只能等 15 分钟陈旧接管。
      this.releaseMemberLock(groupId, agentId);
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
