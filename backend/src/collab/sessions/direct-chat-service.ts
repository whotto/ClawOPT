import path from 'path';
import type { Response as ExpressResponse } from 'express';

import {
  type AgentProvisioner,
  hasHeader,
  type ImageGenerationEndpointModelSnapshot,
  readMaxPermissionsEnabled,
} from '../../control';
import type { DB } from '../../core/db';
import { normalizeCliText } from '../../core/util';
import {
  buildAudioTranscriptContext,
  buildDocumentToolingContext,
  buildImageUploadInspectionContext,
  ensureManagedDocumentToolingReady,
  hasDocumentUploads,
  prepareAudioTranscriptsFromUploads,
  rewriteMessageWithWorkspaceUploads,
} from '../../workspace';
import { isStreamingClientOpen } from './chat-run-managers';
import { rewriteOpenClawMediaPaths, splitChatProcessOutput } from './process-text';
import type { SessionRuntime } from './session-runtime';

function buildDirectChatRequestUrl(endpoint: ImageGenerationEndpointModelSnapshot): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function buildDirectModelRequestHeaders(endpoint: ImageGenerationEndpointModelSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    ...(endpoint.headers || {}),
    'Content-Type': 'application/json',
  };

  const authHeader = endpoint.authHeader || 'Authorization';
  if (!hasHeader(headers, authHeader)) {
    headers[authHeader] = authHeader.toLowerCase() === 'authorization'
      ? `Bearer ${endpoint.apiKey}`
      : endpoint.apiKey;
  }

  return headers;
}

function sanitizeDirectModelErrorDetail(detail: string, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const normalized = normalizeCliText(detail);
  if (!normalized) return 'Direct model request failed.';

  let sanitized = normalized;
  const secret = endpoint?.apiKey;
  if (secret && secret.length >= 6) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }

  return sanitized.length > 2000 ? `${sanitized.slice(0, 2000)}...` : sanitized;
}

async function readDirectModelErrorDetail(response: Response, endpoint: ImageGenerationEndpointModelSnapshot): Promise<string> {
  const bodyText = await response.text().catch(() => '');
  let bodyDetail = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText);
    bodyDetail = normalizeCliText(parsed?.error?.message)
      || normalizeCliText(parsed?.message)
      || normalizeCliText(parsed?.detail)
      || normalizeCliText(parsed?.error)
      || bodyDetail;
  } catch {}

  return sanitizeDirectModelErrorDetail(
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${bodyDetail ? ` - ${bodyDetail}` : ''}`,
    endpoint,
  );
}

function normalizeDirectModelText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof (value as any)?.text === 'string') return (value as any).text;
  if (typeof (value as any)?.content === 'string') return (value as any).content;
  return '';
}

function extractDirectModelDeltaText(payload: any): string {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return normalizeDirectModelText(choice?.delta?.content)
    || normalizeDirectModelText(choice?.message?.content)
    || normalizeDirectModelText(payload?.delta?.content)
    || normalizeDirectModelText(payload?.content);
}

export type DirectChatServiceDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionRuntime: SessionRuntime;
};

export function createDirectChatService(ctx: DirectChatServiceDeps) {
  const { agentProvisioner, db } = ctx;
  const { assertSessionInterruptionEpoch, getSessionWorkspacePath } = ctx.sessionRuntime;

  // Helper to rewrite outgoing messages: extract /uploads/ images as attachments for the Vision API,
  // keep non-image file references as absolute paths in the message text, and inject automatic
  // transcripts for referenced audio uploads when this host has a usable audio transcription provider.
  async function prepareOutgoingMessage(
    message: string,
    agentId: string,
    options: { includeDocumentToolingContext?: boolean } = {},
  ): Promise<{ text: string; attachments: { type: string; mimeType: string; content: string }[] }> {
    const workspacePath = agentProvisioner.getWorkspacePath(agentId);
    const absoluteUploadsDir = path.join(workspacePath, 'uploads');
    const rewritten = rewriteMessageWithWorkspaceUploads(message, absoluteUploadsDir, { extractImageAttachments: true });
    const includeDocumentToolingContext = options.includeDocumentToolingContext !== false;
    if (includeDocumentToolingContext && readMaxPermissionsEnabled() === true && hasDocumentUploads(rewritten.linkedUploads)) {
      try {
        await ensureManagedDocumentToolingReady();
      } catch (error) {
        console.error('Failed to prepare managed document tooling runtime for outgoing message:', error);
      }
    }
    const imageInspectionContext = buildImageUploadInspectionContext(rewritten.linkedUploads);
    const documentToolingContext = includeDocumentToolingContext ? buildDocumentToolingContext(rewritten.linkedUploads) : '';
    const transcripts = await prepareAudioTranscriptsFromUploads(rewritten.linkedUploads, agentId);
    const audioTranscriptContext = buildAudioTranscriptContext(transcripts);

    return {
      text: [rewritten.text, imageInspectionContext, documentToolingContext, audioTranscriptContext].filter(Boolean).join('\n\n').trim(),
      attachments: rewritten.attachments,
    };
  }

  function buildDirectChatMessages(params: {
    sessionId: string;
    agentId: string;
    userMessageId: number;
    assistantMessageId: number;
    currentUserText: string;
    attachments: { type: string; mimeType: string; content: string }[];
  }): Array<{ role: 'system' | 'user' | 'assistant'; content: any }> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];
    const systemPrompt = agentProvisioner.buildAgentSystemPromptOverride(params.agentId).trim();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    const history = db.getMessages(params.sessionId, 40);
    for (const row of history) {
      if (row.id === params.assistantMessageId) continue;
      if (row.role !== 'user' && row.role !== 'assistant') continue;

      let content = row.id === params.userMessageId ? params.currentUserText : row.content;
      content = normalizeCliText(content);
      if (!content) continue;

      if (row.role === 'user' && row.id === params.userMessageId && params.attachments.length > 0) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: content },
            ...params.attachments
              .filter((attachment) => attachment.type === 'image' && attachment.content)
              .map((attachment) => ({
                type: 'image_url',
                image_url: {
                  url: `data:${attachment.mimeType || 'image/png'};base64,${attachment.content}`,
                },
              })),
          ],
        });
        continue;
      }

      messages.push({ role: row.role, content });
    }

    return messages;
  }

  async function runDirectChatCompletion(params: {
    sessionId: string;
    agentId: string;
    userMessageId: number;
    assistantMessageId: number;
    message: string;
    modelUsed: string;
    response: ExpressResponse;
    signal?: AbortSignal;
    onEvent?: (event: Record<string, unknown>) => void;
    processStartTag?: string;
    processEndTag?: string;
    sessionInterruptionEpoch: number;
  }): Promise<void> {
    const endpoint = agentProvisioner.readEndpointModel(params.modelUsed);
    if (!endpoint) {
      throw new Error(`Direct runtime model is not configured: ${params.modelUsed}`);
    }
    if (!endpoint.api.toLowerCase().includes('openai')) {
      throw new Error(`Direct runtime currently supports OpenAI-compatible chat endpoints only: ${endpoint.api}`);
    }

    const outgoingMessage = await prepareOutgoingMessage(params.message, params.agentId, {
      includeDocumentToolingContext: false,
    });
    const messages = buildDirectChatMessages({
      sessionId: params.sessionId,
      agentId: params.agentId,
      userMessageId: params.userMessageId,
      assistantMessageId: params.assistantMessageId,
      currentUserText: outgoingMessage.text,
      attachments: outgoingMessage.attachments,
    });
    if (messages.length === 0) {
      throw new Error('Direct runtime has no message content to send.');
    }

    let rawText = '';
    let lastVisibleText = '';
    let lastVisibleProcessContent = '';
    let lastVisibleProcessStreaming = false;

    const emitSnapshot = (type: 'delta' | 'final') => {
      const split = splitChatProcessOutput(rawText, params.processStartTag, params.processEndTag);
      const visibleText = rewriteOpenClawMediaPaths(split.finalContent, getSessionWorkspacePath(params.sessionId));
      const visibleProcessContent = rewriteOpenClawMediaPaths(split.processContent, getSessionWorkspacePath(params.sessionId));
      const visibleProcessStreaming = type === 'final' ? false : split.processStreaming;
      const changed = visibleText !== lastVisibleText
        || visibleProcessContent !== lastVisibleProcessContent
        || visibleProcessStreaming !== lastVisibleProcessStreaming;

      if (type === 'delta' && !changed) return;

      lastVisibleText = visibleText;
      lastVisibleProcessContent = visibleProcessContent;
      lastVisibleProcessStreaming = visibleProcessStreaming;
      db.updateMessage(params.assistantMessageId, visibleText, params.modelUsed, visibleProcessContent, visibleProcessStreaming);
      const event = {
        type,
        text: visibleText,
        process_content: visibleProcessContent,
        process_streaming: visibleProcessStreaming,
        modelUsed: params.modelUsed,
        model_used: params.modelUsed,
      };
      if (isStreamingClientOpen(params.response)) {
        try {
          params.response.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {}
      }
      params.onEvent?.(event);
    };

    try {
      assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
      const response = await fetch(buildDirectChatRequestUrl(endpoint), {
        method: 'POST',
        headers: buildDirectModelRequestHeaders(endpoint),
        body: JSON.stringify({
          model: endpoint.modelName,
          messages,
          stream: true,
        }),
        signal: params.signal,
      });

      if (!response.ok) {
        throw new Error(await readDirectModelErrorDetail(response, endpoint));
      }

      if (!response.body) {
        const payload = await response.json().catch(() => null) as any;
        rawText = normalizeDirectModelText(payload?.choices?.[0]?.message?.content);
        if (!rawText.trim()) {
          throw new Error('Direct runtime returned an empty response.');
        }
        emitSnapshot('final');
        params.response.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const eventBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const line of eventBlock.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = extractDirectModelDeltaText(parsed);
              if (delta) {
                rawText += delta;
                emitSnapshot('delta');
              }
            } catch {}
          }

          boundary = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = extractDirectModelDeltaText(parsed);
            if (delta) rawText += delta;
          } catch {}
        }
      }

      if (!rawText.trim()) {
        throw new Error('Direct runtime returned an empty response.');
      }

      assertSessionInterruptionEpoch(params.sessionId, params.sessionInterruptionEpoch);
      emitSnapshot('final');
      params.response.end();
    } catch (error) {
      throw error;
    }
  }

  return {
    prepareOutgoingMessage,
    runDirectChatCompletion,
  };
}
export type DirectChatService = ReturnType<typeof createDirectChatService>;
