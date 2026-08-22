import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Lang = 'zh-CN' | 'en';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const textMap = {
  'zh-CN': {
    title: 'ClawOPT',
    subtitle: 'OpenClaw Web 客户端',
    start: '开始对话',
    hint: '在下方输入消息',
    placeholder: '输入消息...',
    send: '发送',
    uploading: '上传中...',
    connected: '已连接',
    checking: '检测中...',
    disconnected: '未连接',
    upload: '上传文件/语音',
    codeBlock: '代码块',
    dropHint: '拖拽文件到此处上传（支持多文件）',
    copied: '已复制',
  },
  en: {
    title: 'ClawOPT',
    subtitle: 'OpenClaw Web Client',
    start: 'Start a conversation',
    hint: 'Type a message below',
    placeholder: 'Type a message...',
    send: 'Send',
    uploading: 'Uploading...',
    connected: 'Connected',
    checking: 'Checking...',
    disconnected: 'Disconnected',
    upload: 'Upload file/voice',
    codeBlock: 'Code block',
    dropHint: 'Drop files here to upload (multiple supported)',
    copied: 'Copied',
  },
};

export default function ChatPage({ lang = 'zh-CN' }: { lang?: Lang }) {
  const t = textMap[lang];
  const sessionId = '5741707482';
  const API_BASE = `${window.location.protocol}//${window.location.hostname}:3100`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkConnection();
    loadHistory();
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadHistory = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/history/${sessionId}`);
      const d = await r.json();
      if (d?.success && Array.isArray(d.messages)) {
        const rows = d.messages.map((m: any) => ({
          id: String(m.id || Math.random()),
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || ''),
          timestamp: new Date(m.created_at || Date.now()),
        }));
        setMessages(rows);
      }
    } catch {}
  };

  const checkConnection = async () => {
    try {
      const response = await fetch(`${API_BASE}/health`);
      setConnectionStatus(response.ok ? 'connected' : 'disconnected');
    } catch {
      setConnectionStatus('disconnected');
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('sessionId', sessionId);

    setUploading(true);
    try {
      const r = await fetch(`${API_BASE}/api/files/upload`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok || !d?.success) throw new Error(d?.error || 'upload failed');

      const fileNames = (d.files || files).map((f: any) => `📎 ${f.name || f.originalname || 'file'}`).join('\n');
      setMessages(prev => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'user',
          content: fileNames,
          timestamp: new Date(),
        },
      ]);
    } catch (e: any) {
      setMessages(prev => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `❌ ${e?.message || 'Upload failed'}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);

      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: userMessage.content }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        let detail = '';
        try {
          const errJson = await response.json();
          detail = errJson?.error || errJson?.message || JSON.stringify(errJson);
        } catch {
          detail = await response.text();
        }
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response || 'No response',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      const errorText = error?.name === 'AbortError' ? '后端超时（120s）' : (error?.message || 'Unknown error');
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `❌ 请求失败：${errorText}`,
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const insertCodeBlock = () => {
    const block = '```\n\n```';
    setInput((prev) => (prev ? `${prev}\n${block}` : block));
  };

  const copyCode = async (code: string, id: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div
      className="flex flex-col h-screen bg-gray-50"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const files = Array.from(e.dataTransfer.files || []);
        uploadFiles(files);
      }}
    >
      {dragActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-white text-xl font-semibold">
          {t.dropHint}
        </div>
      )}

      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t.title}</h1>
          <p className="text-sm text-gray-500">{t.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${
            connectionStatus === 'connected' ? 'bg-green-500' :
            connectionStatus === 'checking' ? 'bg-yellow-500' : 'bg-red-500'
          }`} />
          <span className="text-sm text-gray-600">
            {connectionStatus === 'connected' ? t.connected : connectionStatus === 'checking' ? t.checking : t.disconnected}
          </span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <p className="text-lg font-medium">{t.start}</p>
            <p className="text-sm">{t.hint}</p>
          </div>
        ) : (
          <div className="space-y-4 max-w-4xl mx-auto">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-900'}`}>
                  <div className={`prose prose-sm max-w-none whitespace-pre-wrap ${msg.role === 'user' ? 'prose-invert' : ''}`}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code(props) {
                          const { children, className, ...rest } = props as any;
                          const raw = String(children || '').replace(/\n$/, '');
                          const isBlock = !!className;
                          if (!isBlock) return <code {...rest} className={className}>{children}</code>;
                          const codeId = `${msg.id}-${raw.slice(0, 16)}`;
                          return (
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => copyCode(raw, codeId)}
                                className="absolute right-2 top-2 text-xs px-2 py-1 rounded bg-gray-200 text-gray-700 hover:bg-gray-300"
                              >
                                {copiedId === codeId ? t.copied : 'Copy'}
                              </button>
                              <code {...rest} className={className}>{children}</code>
                            </div>
                          );
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                  <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-blue-200' : 'text-gray-400'}`}>
                    {msg.timestamp.toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 bg-white p-4">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-3 border border-gray-300 rounded-lg hover:bg-gray-50"
              disabled={uploading}
            >
              {uploading ? t.uploading : t.upload}
            </button>
            <button
              type="button"
              onClick={insertCodeBlock}
              className="px-3 py-3 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              {t.codeBlock}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="*/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                uploadFiles(files);
              }}
            />

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t.placeholder}
              disabled={isLoading}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {t.send}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
