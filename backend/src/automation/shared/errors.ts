/**
 * 自动化模块的结构化错误。前端按 `errorCode` 本地化主句，`errorDetail` 只作诊断信息展示。
 * 错误码按域加前缀：`workflows.*` `schedules.*` `webhooks.*` `kanban.*` `hooks.*`。
 */
import { StructuredRequestError, type StructuredMessageParams } from '../../core/http';

export class AutomationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: StructuredMessageParams | null;

  constructor(status: number, code: string, detail?: string, params?: StructuredMessageParams | null) {
    super(detail || code);
    this.name = 'AutomationError';
    this.status = status;
    this.code = code;
    this.params = params ?? null;
  }

  toRequestError(): StructuredRequestError {
    return new StructuredRequestError(this.status, this.code, this.message === this.code ? null : this.message, this.params);
  }
}

export const badRequest = (code: string, detail?: string, params?: StructuredMessageParams) => new AutomationError(400, code, detail, params);
export const notFound = (code: string, detail?: string, params?: StructuredMessageParams) => new AutomationError(404, code, detail, params);
export const conflict = (code: string, detail?: string, params?: StructuredMessageParams) => new AutomationError(409, code, detail, params);

export const WORKFLOW_ERROR = {
  notFound: 'workflows.notFound',
  runNotFound: 'workflows.runNotFound',
  invalidGraph: 'workflows.invalidGraph',
  invalidBody: 'workflows.invalidBody',
  alreadyRunning: 'workflows.alreadyRunning',
  budgetExceeded: 'workflows.staticBudgetExceeded',
  agentUnavailable: 'workflows.agentUnavailable',
  skillMissing: 'workflows.skillMissing',
  attachmentMissing: 'workflows.attachmentMissing',
  noPendingApproval: 'workflows.noPendingApproval',
  runNotTerminal: 'workflows.runNotTerminal',
  rerunNothingToRun: 'workflows.rerunNothingToRun',
  rerunMissingDecision: 'workflows.rerunMissingDecision',
  rerunChanged: 'workflows.rerunChanged',
  rerunNodeNotCompleted: 'workflows.rerunNodeNotCompleted',
  importInvalid: 'workflows.importInvalid',
  importCredential: 'workflows.importCredentialKey',
  importTooLarge: 'workflows.importTooLarge',
  importTokenInvalid: 'workflows.importTokenInvalid',
  batchTooLarge: 'workflows.batchTooLarge',
} as const;

export const SCHEDULE_ERROR = {
  notFound: 'schedules.notFound',
  invalidCron: 'schedules.invalidCron',
  invalidTimezone: 'schedules.invalidTimezone',
  invalidBody: 'schedules.invalidBody',
} as const;

export const WEBHOOK_ERROR = {
  notFound: 'webhooks.notFound',
  invalidBody: 'webhooks.invalidBody',
  urlBlocked: 'webhooks.urlBlocked',
  testFailed: 'webhooks.testFailed',
} as const;

export const HOOK_ERROR = {
  notFound: 'hooks.notFound',
  signatureInvalid: 'hooks.signatureInvalid',
  timestampOutOfWindow: 'hooks.timestampOutOfWindow',
  replayed: 'hooks.replayed',
} as const;

export const KANBAN_ERROR = {
  boardNotFound: 'kanban.boardNotFound',
  taskNotFound: 'kanban.taskNotFound',
  invalidBody: 'kanban.invalidBody',
  invalidTransition: 'kanban.invalidTransition',
  assigneeRequired: 'kanban.assigneeRequired',
  reasonRequired: 'kanban.reasonRequired',
  bulkTooLarge: 'kanban.bulkTooLarge',
  linkCycle: 'kanban.linkCycle',
  defaultBoardProtected: 'kanban.defaultBoardProtected',
} as const;
