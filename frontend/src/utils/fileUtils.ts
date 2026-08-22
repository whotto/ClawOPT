import { 
  File as FileIcon, 
  FileText, 
  FileArchive, 
  FileCode, 
  Music, 
  Video, 
  FileSpreadsheet, 
  FileBarChart, 
  FileImage 
} from 'lucide-react';

export function getFileIconInfo(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  let Icon = FileIcon;
  let typeText = '文件';
  let bgColor = 'bg-blue-500';

  if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) {
    Icon = FileText;
    typeText = (ext === 'pdf' ? 'PDF' : '文档');
    bgColor = 'bg-rose-500';
  } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    Icon = FileArchive;
    typeText = '压缩包';
    bgColor = 'bg-amber-500';
  } else if (['js', 'ts', 'py', 'json', 'html', 'css', 'yaml', 'yml'].includes(ext)) {
    Icon = FileCode;
    typeText = '代码';
    bgColor = 'bg-slate-700';
  } else if (['mp3', 'flac', 'wav'].includes(ext)) {
    Icon = Music;
    typeText = '音频';
    bgColor = 'bg-purple-500';
  } else if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) {
    Icon = Video;
    typeText = '视频';
    bgColor = 'bg-indigo-500';
  } else if (['xls', 'xlsx', 'csv'].includes(ext)) {
    Icon = FileSpreadsheet;
    typeText = '表格';
    bgColor = 'bg-emerald-500';
  } else if (['ppt', 'pptx'].includes(ext)) {
    Icon = FileBarChart;
    typeText = '演示文稿';
    bgColor = 'bg-orange-500';
  } else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    Icon = FileImage;
    typeText = '图片';
    bgColor = 'bg-sky-500';
  }
  
  return { Icon, typeText, bgColor };
}
