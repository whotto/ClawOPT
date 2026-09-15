/**
 * 节点提示词组装。单条用户消息，顺序固定：上游结果 → 选定技能 → 当前任务。
 * 附件变成内容块（图片 / 文件），**上游附件不继承**——下游只拿到上游的文字结果。
 */
import type { AttachmentResolver, ContentBlocks } from '../ports';
import type { WorkflowAttachment } from './types';

export const WORKFLOW_NODE_SYSTEM_CONTEXT = [
  '[Workflow node context]',
  'You are executing one node of an automated workflow.',
  'Focus on the current task. Use upstream results as context and do not redo upstream work; point out conflicts between them.',
  'Return the result concisely. Do not describe the workflow mechanics.',
].join('\n');

export const DEFAULT_NODE_TASK = 'Execute the current workflow node.';

export type UpstreamBlock = { title: string; text: string; failed: boolean };
export type SkillBlock = { name: string; content: string };

export function buildNodePromptText(input: { upstream: UpstreamBlock[]; skills: SkillBlock[]; task: string }): string {
  const parts: string[] = [WORKFLOW_NODE_SYSTEM_CONTEXT];
  if (input.upstream.length) {
    parts.push('[Workflow upstream results]');
    for (const block of input.upstream) {
      parts.push(`[Upstream: ${block.title}${block.failed ? ' (failed)' : ''}]\n${block.text}`);
    }
  }
  if (input.skills.length) {
    parts.push('[Workflow selected skills]');
    for (const skill of input.skills) {
      parts.push(`[Skill: ${skill.name}]\n${skill.content}`);
    }
  }
  parts.push(`[Current task]\n${input.task.trim() ? input.task : DEFAULT_NODE_TASK}`);
  return parts.join('\n\n');
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
};

export function mediaTypeForName(name: string): { kind: 'image' | 'file'; mediaType: string } {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (IMAGE_TYPES[ext]) return { kind: 'image', mediaType: IMAGE_TYPES[ext] };
  return { kind: 'file', mediaType: FILE_TYPES[ext] ?? 'application/octet-stream' };
}

export class AttachmentMissingError extends Error {
  constructor(readonly url: string) {
    super(`attachment is not available: ${url}`);
    this.name = 'AttachmentMissingError';
  }
}

export function buildContentBlocks(text: string, attachments: WorkflowAttachment[], resolve: AttachmentResolver): ContentBlocks {
  const blocks: ContentBlocks = [{ type: 'text', text }];
  for (const attachment of attachments) {
    const resolved = resolve(attachment.url);
    if (!resolved) throw new AttachmentMissingError(attachment.url);
    const { kind, mediaType } = mediaTypeForName(resolved.name || attachment.name);
    blocks.push({ type: kind, path: resolved.path, mediaType, name: attachment.name });
  }
  return blocks;
}

export function contentBlocksToText(blocks: ContentBlocks): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : `[${block.type}: ${block.name}]`)).join('\n\n');
}
