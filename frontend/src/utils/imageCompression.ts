/**
 * Compress an image file to meet size requirements
 * @param file - The image file to compress
 * @param maxSizeBytes - Maximum size in bytes (default 2MB)
 * @param quality - Initial quality (0-1, default 0.8)
 * @returns Compressed file or original if already small enough
 */
export async function compressImage(
  file: File,
  maxSizeBytes: number = 2 * 1024 * 1024,
  quality: number = 0.8
): Promise<File> {
  // If already small enough, return original
  if (file.size <= maxSizeBytes) {
    return file;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('无法创建 canvas context'));
      return;
    }

    img.onload = () => {
      // Calculate new dimensions (max 2048px on longest side)
      let { width, height } = img;
      const maxDimension = 2048;

      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = (height / width) * maxDimension;
          width = maxDimension;
        } else {
          width = (width / height) * maxDimension;
          height = maxDimension;
        }
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // Try compression with decreasing quality
      const tryCompress = (q: number) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('压缩失败'));
              return;
            }

            // If still too large and quality can be reduced, try again
            if (blob.size > maxSizeBytes && q > 0.1) {
              tryCompress(q - 0.1);
              return;
            }

            // Create new file from blob
            const compressedFile = new File([blob], file.name, {
              type: file.type,
              lastModified: Date.now(),
            });

            resolve(compressedFile);
          },
          file.type,
          q
        );
      };

      tryCompress(quality);
    };

    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Get file type category
 */
export function getFileCategory(file: File): 'image' | 'video' | 'audio' | 'document' | 'other' {
  const type = file.type.toLowerCase();

  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (
    type.includes('pdf') ||
    type.includes('document') ||
    type.includes('word') ||
    type.includes('excel') ||
    type.includes('powerpoint') ||
    type.includes('text')
  ) return 'document';

  return 'other';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
