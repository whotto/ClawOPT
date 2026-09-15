// 访客页（P3 任务 10）：凭邀请链接进群——填名字选头像加入；看消息、@ Agent、上传附件、撤回自己排队中的消息、
// 配对自己的远程 Agent 并答复它的审批。访客不能管理房间、不能 @all、看不到工作区。
import { Loader2, Paperclip, PlugZap, Send, Undo2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import type { ChatMessage } from '../../../utils/message-merge';
import { markdownRehypePlugins, markdownRemarkPlugins } from '../../../utils/markdownMath';
import {
  applyFinalFrame, applyPatchBatch, LiveDeltaBatcher, MessageTombstones, removeEmptyAssistantBubbles,
} from '../../../utils/room-live-merge';
import { mapGroupMsg } from '../../chat/lib/messageMapping';
import { RoomApiError, type QueueSnapshot, type RoomInteraction } from '../api';
import { fetchUploadTransport, uploadInChunks } from '../chunkedUpload';
import { activeMentionQuery, buildStructuredMentions, insertMentionAt, type MentionRange, rebaseMentionRanges } from '../mentionRanges';
import { RoomInteractions } from '../RoomInteractions';
import { roomQueueCapability } from '../roomStorage';
import {
  createGuestApi, type GuestRoomInfo, type GuestSelf, loadGuestToken, readEventStream, storedNameFromUploadUrl, storeGuestToken,
} from './guestApi';

const AVATARS = ['🦊', '🐼', '🐯', '🐙', '🦉', '🐳', '🌻', '🚀'];

export default function GuestRoomPage() {
  const { code = '' } = useParams();
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(() => loadGuestToken(code));
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const api = useMemo(() => createGuestApi(code, () => tokenRef.current), [code]);
  const [room, setRoom] = useState<GuestRoomInfo | null>(null);
  const [self, setSelf] = useState<GuestSelf | null>(null);
  const [loadError, setLoadError] = useState('');
  const errorText = (err: unknown) => (err instanceof RoomApiError ? String(t(err.code, { defaultValue: err.message })) : String((err as Error)?.message ?? err));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (tokenRef.current) {
          try {
            const me = await api.me();
            if (cancelled) return;
            setSelf(me.guest);
            setRoom(me.room);
            return;
          } catch (err) {
            if (err instanceof RoomApiError && err.status === 401) { storeGuestToken(code, null); setToken(null); } else throw err;
          }
        }
        const info = await api.info();
        if (!cancelled) setRoom(info.room);
      } catch (err) {
        if (!cancelled) setLoadError(errorText(err));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, code]);

  const signOut = useCallback(() => { storeGuestToken(code, null); setToken(null); setSelf(null); }, [code]);

  if (loadError) return <CenteredNote title={t('rooms.guest.unavailable')} text={loadError} />;
  if (!room) return <CenteredNote title={t('rooms.guest.loading')} spinner />;
  if (!self || !token) {
    return (
      <JoinForm room={room} onJoin={async (name, avatar) => {
        const joined = await api.join(name, avatar);
        storeGuestToken(code, joined.guestToken);
        setToken(joined.guestToken);
        setSelf(joined.guest);
        setRoom(joined.room);
      }} errorText={errorText} />
    );
  }
  return <GuestRoom code={code} api={api} room={room} self={self} onUnauthorized={signOut} errorText={errorText} />;
}

function CenteredNote({ title, text, spinner }: { title: string; text?: string; spinner?: boolean }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full rounded-2xl border border-gray-200 bg-white p-6 text-center">
        {spinner && <Loader2 className="w-6 h-6 mx-auto mb-3 animate-spin text-gray-400" />}
        <h1 className="text-lg font-bold text-gray-900">{title}</h1>
        {text && <p className="mt-2 text-sm text-gray-500 break-words">{text}</p>}
      </div>
    </div>
  );
}

function JoinForm({ room, onJoin, errorText }: { room: GuestRoomInfo; onJoin: (name: string, avatar: string) => Promise<void>; errorText: (err: unknown) => string }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4" data-testid="guest-join">
      <form
        className="max-w-md w-full rounded-2xl border border-gray-200 bg-white p-6 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try { await onJoin(name, avatar); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
        }}
      >
        <div>
          <p className="text-xs text-gray-400">{t('rooms.guest.invitedTo')}</p>
          <h1 className="text-xl font-bold text-gray-900">{room.name}</h1>
          <p className="mt-1 text-xs text-gray-500 flex items-center gap-1"><Users className="w-3.5 h-3.5" />{room.agents.map((agent) => agent.name).join('、')}</p>
        </div>
        <label className="block">
          <span className="text-sm text-gray-700">{t('rooms.guest.name')}</span>
          <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:border-blue-500" autoFocus />
        </label>
        <div>
          <span className="text-sm text-gray-700">{t('rooms.guest.avatar')}</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {AVATARS.map((item) => (
              <button key={item} type="button" onClick={() => setAvatar(item)} className={`w-10 h-10 rounded-full text-xl ${avatar === item ? 'ring-2 ring-blue-500 bg-blue-50' : 'bg-gray-100'}`}>{item}</button>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-400">{t('rooms.guest.joinHint')}</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy || !name.trim()} className="w-full rounded-lg bg-blue-600 py-2.5 text-white font-semibold disabled:opacity-50">{t('rooms.guest.join')}</button>
      </form>
    </div>
  );
}

function GuestRoom({ code, api, room, self, onUnauthorized, errorText }: {
  code: string;
  api: ReturnType<typeof createGuestApi>;
  room: GuestRoomInfo;
  self: GuestSelf;
  onUnauthorized: () => void;
  errorText: (err: unknown) => string;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queue, setQueue] = useState<QueueSnapshot>({ items: [], busyMembers: [] });
  const [interactions, setInteractions] = useState<RoomInteraction[]>([]);
  const [input, setInput] = useState('');
  const rangesRef = useRef<MentionRange[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [showPairing, setShowPairing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const capability = roomQueueCapability(`guest:${code}`);

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (err) {
      if (err instanceof RoomApiError && err.status === 401) onUnauthorized();
      else setNotice(errorText(err));
      return null;
    }
  }, [errorText, onUnauthorized]);

  const reload = useCallback(async () => {
    const page = await guard(() => api.messages());
    if (page) setMessages((prev) => {
      const incoming = (page.messages as any[]).map(mapGroupMsg);
      const byId = new Map(prev.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, byId.has(message.id) ? { ...byId.get(message.id)!, ...message } : message);
      return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
    });
    const q = await guard(() => api.queue());
    if (q) setQueue({ items: q.items, busyMembers: q.busyMembers });
    const i = await guard(() => api.interactions());
    if (i) setInteractions(i.interactions);
  }, [api, guard]);

  // 事件流：fetch 读 SSE（带令牌头），断了按 1s→10s 退避重连，重连后补拉一遍。
  useEffect(() => {
    const controller = new AbortController();
    const tombstones = new MessageTombstones();
    const batcher = new LiveDeltaBatcher((batch) => setMessages((prev) => applyPatchBatch(prev, batch, tombstones)), tombstones);
    let delay = 1000;
    const onFrame = (frame: any) => {
      switch (frame?.type) {
        case 'message': {
          const mapped = mapGroupMsg(frame.data);
          const pending = batcher.take(mapped.id);
          setMessages((prev) => applyFinalFrame(prev, mapped, pending, tombstones));
          break;
        }
        case 'delta': {
          const id = String(frame.id);
          if (tombstones.has(id)) break;
          setMessages((prev) => (prev.some((m) => m.id === id) ? prev : applyFinalFrame(prev, mapGroupMsg(frame), undefined, tombstones)));
          batcher.push(id, { content: typeof frame.content === 'string' ? frame.content : '', ...(typeof frame.process_content === 'string' ? { processContent: frame.process_content } : {}), ...(typeof frame.process_streaming === 'boolean' ? { processStreaming: frame.process_streaming } : {}) });
          break;
        }
        case 'edit': {
          const mapped = mapGroupMsg(frame);
          setMessages((prev) => applyFinalFrame(prev, mapped, batcher.take(mapped.id), tombstones));
          break;
        }
        case 'delete': {
          const ids = Array.isArray(frame.deletedIds) ? frame.deletedIds.map(String) : frame.id !== undefined ? [String(frame.id)] : [];
          tombstones.add(ids);
          batcher.drop(ids);
          setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
          break;
        }
        case 'message_retracted': {
          const id = String(frame.data?.messageId);
          tombstones.add([id]);
          batcher.drop([id]);
          setMessages((prev) => prev.filter((m) => m.id !== id));
          void guard(() => api.queue()).then((q) => q && setQueue({ items: q.items, busyMembers: q.busyMembers }));
          break;
        }
        case 'queue':
          if (frame.data?.items) setQueue({ items: frame.data.items, busyMembers: frame.data.busyMembers ?? [] });
          break;
        case 'interactions':
          void guard(() => api.interactions()).then((i) => i && setInteractions(i.interactions));
          break;
        case 'run_state':
          if (!frame.data?.active) { batcher.flush(); setMessages((prev) => removeEmptyAssistantBubbles(prev)); }
          break;
        default:
          break;
      }
    };
    (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${api.base}/events`, { headers: api.headers(), signal: controller.signal });
          if (response.status === 401) { onUnauthorized(); return; }
          delay = 1000;
          await reload();
          await readEventStream(response, onFrame, controller.signal);
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(10_000, delay * 2);
      }
    })();
    return () => { controller.abort(); batcher.dispose(); };
  }, [api, guard, onUnauthorized, reload]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  const agents = room.agents;
  const candidates = mentionQuery === null ? [] : agents.filter((agent) => agent.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);

  const onChange = (value: string, cursor: number) => {
    rangesRef.current = rebaseMentionRanges(input, value, rangesRef.current);
    setInput(value);
    setMentionQuery(activeMentionQuery(value, cursor));
  };
  const pick = (agent: { id: string; name: string }) => {
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const inserted = insertMentionAt(input, cursor, { memberId: agent.id, name: agent.name }, rangesRef.current);
    rangesRef.current = inserted.ranges;
    setInput(inserted.text);
    setMentionQuery(null);
    window.setTimeout(() => { const ta = textareaRef.current; if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = inserted.cursor; } }, 0);
  };

  const send = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setNotice('');
    const mentions = buildStructuredMentions(input, rangesRef.current);
    const result = await guard(() => api.send(input.trim(), mentions, capability));
    if (result) {
      setInput('');
      rangesRef.current = [];
      if (result.notice) setNotice(String(t(result.notice.messageCode, { agents: result.notice.agentNames.join('、'), agentName: result.notice.agentNames.join('、') })));
    }
    setBusy(false);
  };

  const upload = async (files: File[]) => {
    for (const file of files) {
      setUploading(file.name);
      const transport = fetchUploadTransport(`${api.base}/uploads`, api.headers());
      const attachment = await guard(() => uploadInChunks(file, transport));
      if (attachment) setInput((prev) => `${prev}${prev ? '\n' : ''}${attachment.kind === 'image' ? '!' : ''}[${attachment.name}](${attachment.url})`);
    }
    setUploading(null);
  };

  const myQueue = queue.items.filter((item) => item.requesterKind === 'guest' && item.requesterGuestId === self.id);

  return (
    <div className="h-screen flex flex-col bg-white" data-testid="guest-room">
      <header className="h-14 px-4 border-b border-gray-200 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold text-gray-900 truncate">{room.name}</h1>
          <p className="text-[11px] text-gray-400 truncate">{t('rooms.guest.youAre', { name: `${self.avatar ?? ''} ${self.name}` })}</p>
        </div>
        {room.allowGuestAgents && (
          <button type="button" onClick={() => setShowPairing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 h-9 text-xs text-gray-600" data-testid="guest-open-pairing">
            <PlugZap className="w-4 h-4" /><span className="hidden sm:inline">{t('rooms.guest.linkAgent')}</span>
          </button>
        )}
      </header>
      <main className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((message) => <GuestMessage key={message.id} message={message} api={api} selfName={self.name} />)}
        <div ref={endRef} />
      </main>
      {myQueue.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 flex gap-2 overflow-x-auto" data-testid="guest-queue">
          {myQueue.map((item) => (
            <span key={item.id} className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-2 py-1 text-xs text-gray-600">
              {t('rooms.guest.queued', { agent: item.targetName, position: item.position })}
              <button type="button" onClick={() => void guard(() => api.retract(item.messageId, capability))} className="text-gray-400 hover:text-red-600" title={t('rooms.queue.retract')}><Undo2 className="w-3.5 h-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      <RoomInteractions interactions={interactions} busyId={null} onRespond={(interaction, response) => void guard(async () => {
        await api.respond(interaction.id, response);
        setInteractions((prev) => prev.filter((item) => item.id !== interaction.id));
      })} />
      <footer className="px-3 sm:px-4 pb-4 pt-2 border-t border-gray-100">
        {notice && <p className="mb-2 text-xs text-amber-700 flex items-start gap-2"><span className="flex-1">{notice}</span><button type="button" onClick={() => setNotice('')}><X className="w-3.5 h-3.5" /></button></p>}
        <div className="relative">
          {candidates.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-gray-200 bg-white py-1 z-20" data-testid="guest-mention-picker">
              {candidates.map((agent) => (
                <button key={agent.id} type="button" onMouseDown={(event) => { event.preventDefault(); pick(agent); }} className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${agent.online ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span className="font-semibold truncate">{agent.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-gray-200 px-2 py-1.5 focus-within:border-blue-500">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
            <button type="button" onClick={() => fileRef.current?.click()} className="w-9 h-9 flex items-center justify-center text-gray-400 hover:text-gray-700" title={t('rooms.guest.attach')}>
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={t('rooms.guest.placeholder')}
              onChange={(event) => onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && candidates.length === 0) { event.preventDefault(); void send(); }
                if ((event.key === 'Enter' || event.key === 'Tab') && candidates.length > 0) { event.preventDefault(); pick(candidates[0]); }
                if (event.key === 'Escape') setMentionQuery(null);
              }}
              className="flex-1 min-h-[36px] max-h-40 resize-none py-2 text-base focus:outline-none"
            />
            <button type="button" disabled={busy || !input.trim()} onClick={() => void send()} className="w-9 h-9 flex items-center justify-center rounded-lg bg-blue-600 text-white disabled:opacity-40" aria-label={t('common.send')}>
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </footer>
      {showPairing && <GuestPairingDialog api={api} onClose={() => setShowPairing(false)} errorText={errorText} />}
    </div>
  );
}

function GuestMessage({ message, api, selfName }: { message: ChatMessage; api: ReturnType<typeof createGuestApi>; selfName: string }) {
  const { t } = useTranslation();
  const mine = message.role === 'user' && !!message.room?.senderGuestId && message.agentName === selfName;
  if (message.role === 'system') {
    return <p className="text-center text-[11px] text-gray-400">{message.messageCode ? t(message.messageCode, { ...(message.messageParams ?? {}), defaultValue: message.content }) : message.content}</p>;
  }
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] sm:max-w-[70%] rounded-2xl px-3 py-2 ${mine ? 'bg-blue-600 text-white' : message.role === 'user' ? 'bg-gray-100 text-gray-900' : 'bg-white border border-gray-200 text-gray-900'}`}>
        {!mine && <p className={`text-[11px] font-semibold mb-0.5 ${message.role === 'assistant' ? 'text-blue-600' : 'text-gray-500'}`}>{message.agentName}</p>}
        {message.processStreaming && !message.content && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        <div className={`prose prose-sm max-w-none break-words ${mine ? 'prose-invert' : ''}`}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={{
              img: ({ src, alt }) => <GuestImage api={api} src={String(src ?? '')} alt={String(alt ?? '')} />,
              a: ({ href, children }) => {
                const stored = storedNameFromUploadUrl(String(href ?? ''));
                if (stored) return <GuestFileLink api={api} stored={stored}>{children}</GuestFileLink>;
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function useGuestBlob(api: ReturnType<typeof createGuestApi>, stored: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!stored) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(api.fileUrl(stored), { headers: api.headers() })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => { if (blob && !revoked) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => {});
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, stored]);
  return url;
}

function GuestImage({ api, src, alt }: { api: ReturnType<typeof createGuestApi>; src: string; alt: string }) {
  const stored = storedNameFromUploadUrl(src);
  const url = useGuestBlob(api, stored);
  if (!stored) return <span className="text-xs text-gray-400">[{alt}]</span>;
  return url ? <img src={url} alt={alt} className="max-h-64 rounded-lg" /> : <span className="text-xs text-gray-400">{alt}</span>;
}

function GuestFileLink({ api, stored, children }: { api: ReturnType<typeof createGuestApi>; stored: string; children: React.ReactNode }) {
  const download = async () => {
    const response = await fetch(api.fileUrl(stored), { headers: api.headers() });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = typeof children === 'string' ? children : stored;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return <button type="button" onClick={() => void download()} className="underline">{children}</button>;
}

function GuestPairingDialog({ api, onClose, errorText }: { api: ReturnType<typeof createGuestApi>; onClose: () => void; errorText: (err: unknown) => string }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [state, setState] = useState<Awaited<ReturnType<typeof api.pairings>> | null>(null);
  const load = useCallback(() => { api.pairings().then(setState).catch(() => {}); }, [api]);
  useEffect(() => { load(); const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, [load]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30" onClick={onClose} data-testid="guest-pairing-dialog">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center"><h2 className="flex-1 font-bold">{t('rooms.guest.linkAgent')}</h2><button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button></div>
        <p className="text-xs text-gray-500">{t('rooms.guest.linkHint')}</p>
        <button type="button" onClick={async () => { setError(''); try { setCode((await api.createPairing()).pairingCode); load(); } catch (err) { setError(errorText(err)); } }} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm">{t('rooms.relay.createCode')}</button>
        {code && <textarea readOnly value={code} className="w-full h-24 rounded-lg border border-gray-200 p-2 font-mono text-[11px] break-all" data-testid="guest-pairing-code" />}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <ul className="space-y-2 text-sm">
          {state?.pairings.map((pairing) => (
            <li key={pairing.requestId} className="rounded-lg border border-gray-200 px-3 py-2">{pairing.descriptor?.name ?? t('rooms.relay.waitingTarget')} · {t(`rooms.relay.status.${pairing.status}`, { defaultValue: pairing.status })}</li>
          ))}
          {state?.connectors.map((connector) => (
            <li key={connector.id} className="rounded-lg border border-gray-200 px-3 py-2 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${connector.online ? 'bg-green-500' : 'bg-gray-300'}`} />
              <span className="flex-1 truncate">{connector.descriptor.name}</span>
              {connector.status !== 'revoked' && <button type="button" onClick={() => void api.revokeConnector(connector.id).then(load)} className="text-xs text-red-600">{t('rooms.relay.revoke')}</button>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
