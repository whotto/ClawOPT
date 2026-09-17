// 上传进度：失败的可「继续上传」（从服务端记下的偏移接着传）或放弃（服务端删掉临时文件）。
import { Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../../../components/control/ControlUi';
import { formatBytes } from '../lib/fileManagerLogic';
import type { UploadItem } from '../useChunkedUploads';

export function UploadList({ items, onResume, onDiscard }: { items: UploadItem[]; onResume: (key: string) => void; onDiscard: (key: string) => void }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <Card className="p-3 space-y-2" >
      {items.map((item) => {
        const percent = item.file.size ? Math.round((item.sent / item.file.size) * 100) : 100;
        return (
          <div key={item.key} className="space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono truncate flex-1 min-w-0">{item.file.name}</span>
              <span className="text-xs text-gray-400 shrink-0">{formatBytes(item.sent)} / {formatBytes(item.file.size)}</span>
              {item.state === 'failed' && <Button size="sm" onClick={() => onResume(item.key)}><Play className="w-3.5 h-3.5" />{t('fileManager.page.resumeUpload')}</Button>}
              <button type="button" onClick={() => onDiscard(item.key)} className="p-1 text-gray-400 hover:text-gray-700" title={item.state === 'done' ? t('common.close') : t('fileManager.page.cancelUpload')}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className={`h-full ${item.state === 'failed' ? 'bg-red-400' : item.state === 'done' ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${percent}%` }} />
            </div>
            {item.state === 'failed' && item.errorCode && <div className="text-xs text-red-600">{t(item.errorCode)}</div>}
          </div>
        );
      })}
    </Card>
  );
}
