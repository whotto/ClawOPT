import {
  extractOpenClawMessageError,
  extractOpenClawMessageText,
  normalizeOpenClawMessageRecord,
} from './openclaw-client';

export type ChatHistorySnapshot = {
  length: number;
  latestSignature: string;
  messageSignatures?: string[];
  trusted?: boolean;
};

export type SettledAssistantOutcome =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string };

export type AssistantOutcomeRecord =
  | { kind: 'none'; timestampMs: number | null }
  | { kind: 'text'; text: string; timestampMs: number | null }
  | { kind: 'error'; error: string; timestampMs: number | null };

export type HistoryTailActivity = {
  hasChanges: boolean;
  latestSignature: string;
  latestTimestampMs: number | null;
  length: number;
};

const NON_TERMINAL_ASSISTANT_STOP_REASONS = new Set([
  'tooluse',
  'tool_use',
  'toolcall',
  'tool_call',
  'toolcalls',
  'tool_calls',
]);

function getMessageStopReason(message: any): string {
  const normalizedMessage = normalizeOpenClawMessageRecord(message);
  const stopReason = [normalizedMessage?.stopReason, normalizedMessage?.stop_reason].find((value) => typeof value === 'string');
  return typeof stopReason === 'string' ? stopReason.trim().toLowerCase() : '';
}

export function isNonTerminalAssistantMessage(message: any): boolean {
  const normalizedMessage = normalizeOpenClawMessageRecord(message);
  if (normalizedMessage?.role !== 'assistant') {
    return false;
  }

  return NON_TERMINAL_ASSISTANT_STOP_REASONS.has(getMessageStopReason(normalizedMessage));
}

function getMessageTimestampMs(message: any): number | null {
  const normalizedMessage = normalizeOpenClawMessageRecord(message);
  const rawTimestamp = [normalizedMessage?.timestamp, normalizedMessage?.createdAt, normalizedMessage?.created_at].find((value) => value !== undefined && value !== null);
  if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
    return rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
  }
  if (typeof rawTimestamp === 'string') {
    const numeric = Number(rawTimestamp);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(rawTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function hasHistoryTailChanges(messages: any[], baseline: ChatHistorySnapshot): boolean {
  if (baseline.trusted === false) return false;
  if (messages.length === 0) return false;
  const latestMessage = messages[messages.length - 1];
  return messages.length > baseline.length
    || createHistoryMessageSignature(latestMessage) !== baseline.latestSignature;
}

function getAssistantOutcome(message: any): SettledAssistantOutcome {
  const normalizedMessage = normalizeOpenClawMessageRecord(message);
  if (normalizedMessage?.role !== 'assistant') {
    return { kind: 'none' };
  }

  const stopReason = getMessageStopReason(normalizedMessage);
  const error = extractOpenClawMessageError(normalizedMessage).trim();
  const text = extractOpenClawMessageText(normalizedMessage).trim();

  if (NON_TERMINAL_ASSISTANT_STOP_REASONS.has(stopReason)) {
    return { kind: 'none' };
  }

  if (stopReason === 'error') {
    return { kind: 'error', error: error || 'Unknown error' };
  }

  if (text) {
    return { kind: 'text', text };
  }

  if (error) {
    return { kind: 'error', error };
  }

  return { kind: 'none' };
}

function getAssistantOutcomeRecord(message: any): AssistantOutcomeRecord {
  const outcome = getAssistantOutcome(message);
  const timestampMs = getMessageTimestampMs(message);
  if (outcome.kind === 'text') {
    return { kind: 'text', text: outcome.text, timestampMs };
  }
  if (outcome.kind === 'error') {
    return { kind: 'error', error: outcome.error, timestampMs };
  }
  return { kind: 'none', timestampMs };
}

export function createHistoryMessageSignature(message: any): string {
  if (!message) return '';
  const normalizedMessage = normalizeOpenClawMessageRecord(message);
  const text = extractOpenClawMessageText(normalizedMessage);
  const error = extractOpenClawMessageError(normalizedMessage);
  const stopReason = getMessageStopReason(normalizedMessage);
  const content = (() => {
    try {
      return JSON.stringify(normalizedMessage?.content ?? null);
    } catch {
      return '';
    }
  })();

  return `${String(normalizedMessage?.role || '')}::${stopReason}::${error}::${text}::${content}`;
}

export function getHistorySnapshot(historyPayload: any): ChatHistorySnapshot {
  const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  return {
    length: messages.length,
    latestSignature: createHistoryMessageSignature(latestMessage),
    messageSignatures: messages.map((message: any) => createHistoryMessageSignature(message)).filter(Boolean),
    trusted: true,
  };
}

export function getUnknownHistorySnapshot(): ChatHistorySnapshot {
  return {
    length: 0,
    latestSignature: '',
    messageSignatures: [],
    trusted: false,
  };
}

export function getHistoryTailActivity(historyPayload: any, baseline: ChatHistorySnapshot): HistoryTailActivity {
  const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  return {
    hasChanges: hasHistoryTailChanges(messages, baseline),
    latestSignature: createHistoryMessageSignature(latestMessage),
    latestTimestampMs: getMessageTimestampMs(latestMessage),
    length: messages.length,
  };
}

export function extractSettledAssistantText(historyPayload: any, baseline: ChatHistorySnapshot): string {
  const outcome = extractSettledAssistantOutcome(historyPayload, baseline);
  return outcome.kind === 'text' ? outcome.text : '';
}

export function extractSettledAssistantOutcome(historyPayload: any, baseline: ChatHistorySnapshot): SettledAssistantOutcome {
  const outcome = extractSettledAssistantOutcomeRecord(historyPayload, baseline);
  if (outcome.kind === 'text') {
    return { kind: 'text', text: outcome.text };
  }
  if (outcome.kind === 'error') {
    return { kind: 'error', error: outcome.error };
  }
  return { kind: 'none' };
}

export function extractSettledAssistantOutcomeRecord(historyPayload: any, baseline: ChatHistorySnapshot): AssistantOutcomeRecord {
  if (baseline.trusted === false) {
    return { kind: 'none', timestampMs: null };
  }

  const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
  if (!hasHistoryTailChanges(messages, baseline)) {
    return { kind: 'none', timestampMs: null };
  }

  const baselineSignatures = new Set((baseline.messageSignatures || []).filter(Boolean));
  if (baseline.latestSignature) {
    baselineSignatures.add(baseline.latestSignature);
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const signature = createHistoryMessageSignature(message);
    if (baselineSignatures.has(signature)) {
      break;
    }

    const normalizedMessage = normalizeOpenClawMessageRecord(message);
    if (normalizedMessage?.role !== 'assistant') {
      continue;
    }

    // Only trust the newest assistant record after the run baseline.
    // If it is still a tool-use/intermediate assistant message, wait for the
    // terminal record instead of falling back to an older assistant reply.
    return getAssistantOutcomeRecord(normalizedMessage);
  }

  return { kind: 'none', timestampMs: null };
}

export function extractLatestAssistantOutcome(historyPayload: any): SettledAssistantOutcome {
  const outcome = extractLatestAssistantOutcomeRecord(historyPayload);
  if (outcome.kind === 'text') {
    return { kind: 'text', text: outcome.text };
  }
  if (outcome.kind === 'error') {
    return { kind: 'error', error: outcome.error };
  }
  return { kind: 'none' };
}

export function extractLatestAssistantOutcomeRecord(historyPayload: any): AssistantOutcomeRecord {
  const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const normalizedMessage = normalizeOpenClawMessageRecord(messages[index]);
    if (normalizedMessage?.role !== 'assistant') {
      continue;
    }

    // Only reconcile against the newest assistant record itself.
    // If that newest record is still non-terminal, do not fall back to an older
    // assistant reply from a previous round, otherwise the latest UI message can
    // be incorrectly overwritten with stale content.
    return getAssistantOutcomeRecord(normalizedMessage);
  }

  return { kind: 'none', timestampMs: null };
}

export function shouldPreferSettledAssistantText(currentOutput: string, settledOutput: string): boolean {
  const current = currentOutput.trim();
  const settled = settledOutput.trim();

  if (!settled) return false;
  if (!current) return true;
  if (settled === current) return false;
  if (settled.startsWith(current)) return true;
  if (!current.startsWith(settled) && settled.length >= current.length) return true;

  return false;
}
