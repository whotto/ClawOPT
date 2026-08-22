import fs from 'fs';
import path from 'path';

export type MessageAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

export type WorkspaceUploadLink = {
  altText: string;
  filename: string;
  absolutePath: string;
  mimeType: string | null;
  kind: 'image' | 'audio' | 'video' | 'document' | 'other';
  isEmbeddedImage: boolean;
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const AUDIO_MIME_TYPES: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'audio/webm',
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  avi: 'video/x-msvideo',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function resolveUploadKind(mimeType: string | null, ext: string): WorkspaceUploadLink['kind'] {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';

  if ([
    'pdf',
    'doc',
    'docx',
    'ppt',
    'pptx',
    'xls',
    'xlsx',
    'txt',
    'md',
    'csv',
    'json',
    'html',
    'epub',
  ].includes(ext)) {
    return 'document';
  }

  return 'other';
}

export function rewriteMessageWithWorkspaceUploads(
  message: string,
  absoluteUploadsDir: string,
  options: { extractImageAttachments?: boolean } = {}
): { text: string; attachments: MessageAttachment[]; linkedUploads: WorkspaceUploadLink[] } {
  const attachments: MessageAttachment[] = [];
  const linkedUploads: WorkspaceUploadLink[] = [];
  const extractImageAttachments = options.extractImageAttachments === true;

  const text = message.replace(/(!?)\[([^\]]*)\]\(\/uploads\/([^)]+)\)/g, (_match, exclaim, altText, filename) => {
    const absolutePath = path.join(absoluteUploadsDir, filename);
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    const mimeType = IMAGE_MIME_TYPES[ext] || AUDIO_MIME_TYPES[ext] || VIDEO_MIME_TYPES[ext] || null;

    try {
      if (fs.existsSync(absolutePath)) {
        linkedUploads.push({
          altText,
          filename,
          absolutePath,
          mimeType,
          kind: resolveUploadKind(mimeType, ext),
          isEmbeddedImage: exclaim === '!',
        });
      }
    } catch (error) {
      console.error(`[rewriteMessageWithWorkspaceUploads] Failed to inspect upload ${absolutePath}:`, error);
    }

    if (extractImageAttachments && exclaim === '!' && mimeType?.startsWith('image/')) {
      try {
        if (fs.existsSync(absolutePath)) {
          attachments.push({
            type: 'image',
            mimeType,
            content: fs.readFileSync(absolutePath).toString('base64'),
          });
          return '';
        }
      } catch (error) {
        console.error(`[rewriteMessageWithWorkspaceUploads] Failed to read image ${absolutePath}:`, error);
      }
    }

    return `${exclaim}[${altText}](${absolutePath})`;
  });

  return {
    text: text.trim(),
    attachments,
    linkedUploads,
  };
}

export function buildImageUploadInspectionContext(linkedUploads: WorkspaceUploadLink[]): string {
  const imageUploads = linkedUploads.filter((upload) => upload.kind === 'image' && upload.absolutePath);
  if (imageUploads.length === 0) return '';

  return [
    '[System note: uploaded image files for this turn are also available at the absolute paths below. If native image input is unavailable or appears missing, you MUST inspect these files directly before answering and you must not claim the image was missing before checking them.]',
    ...imageUploads.map((upload, index) => `${index + 1}. ${upload.absolutePath} (${upload.filename})`),
  ].join('\n');
}
