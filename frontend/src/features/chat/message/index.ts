// 聊天消息渲染的对外入口：气泡、过程步骤块与内容解析。
export { MessageBubble } from './MessageBubble';
export type { MessageProps, PendingFile } from './MessageBubble';
export { ProcessStepBlock } from './ProcessStepBlock';
export { normalizeProcessBlocks } from './processContent';
export { parseAttachmentsFromContent } from './attachments';
export type { Attachment } from './attachments';
