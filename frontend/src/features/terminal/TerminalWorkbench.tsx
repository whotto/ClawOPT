// Web 终端工作台：会话标签页、xterm、断线自动重连并接回、生命周期审计。
// 网络全部经 api/terminal.ts；这里只管状态与渲染。关闭页面只是脱离会话（服务端空闲超时后回收），关闭标签页才结束 shell。
import { ChevronDown, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TerminalSocketClient,
  terminalApi,
  type TerminalAuditEntry,
  type TerminalConnectionState,
  type TerminalSessionInfo,
  type TerminalShellOption,
} from '../../api/terminal';
import { Badge, Button, Card, EmptyState, ErrorBanner, formatTime, inputClass, LoadingRow, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../../pages/control/useControlApi';
import { XtermPane, type XtermHandle } from './XtermPane';

type Tab = { id: string; label: string; exited: boolean; exitCode: number | null };

const STATE_TONE: Record<TerminalConnectionState, 'green' | 'amber' | 'gray' | 'red'> = {
  open: 'green',
  connecting: 'amber',
  reconnecting: 'amber',
  closed: 'gray',
  unauthorized: 'red',
};

function tabFrom(session: TerminalSessionInfo): Tab {
  return { id: session.id, label: session.shellLabel || session.shellId, exited: session.exited, exitCode: session.exitCode };
}

export default function TerminalWorkbench() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [state, setState] = useState<TerminalConnectionState>('connecting');
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  const [shellId, setShellId] = useState<string>('');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const clientRef = useRef<TerminalSocketClient | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const handles = useRef(new Map<string, XtermHandle>());
  /** 终端还没挂上时先到的重放 / 输出。 */
  const pending = useRef(new Map<string, { reset: boolean; chunks: string[] }>());

  const write = useCallback((sessionId: string, data: string, reset: boolean) => {
    const handle = handles.current.get(sessionId);
    if (!handle) {
      const queued = pending.current.get(sessionId) ?? { reset: false, chunks: [] };
      if (reset) {
        queued.reset = true;
        queued.chunks = [];
      }
      if (data) queued.chunks.push(data);
      pending.current.set(sessionId, queued);
      return;
    }
    if (reset) handle.term.reset();
    if (data) handle.term.write(data);
  }, []);

  const showError = useCallback((code: string) => {
    setError(errors.fromResult({ ok: false, status: 400, data: { errorCode: code } as never }, 'terminal.internalError'));
  }, [errors]);

  useEffect(() => {
    const client = new TerminalSocketClient({
      onState: setState,
      onReady: (sessions, shellOptions) => {
        setShells(shellOptions);
        setShellId((current) => current || shellOptions.find((shell) => shell.isDefault)?.id || shellOptions[0]?.id || '');
        // 刷新页面或别处留下的会话：重新开成标签并接回（已经在看的由客户端自己按偏移接回）。
        const known = new Set(tabsRef.current.map((tab) => tab.id));
        const added = sessions.filter((session) => !known.has(session.id));
        for (const session of added) client.attach(session.id);
        if (added.length) {
          setTabs((current) => [...current, ...added.filter((session) => !current.some((tab) => tab.id === session.id)).map(tabFrom)]);
          setActiveId((active) => active ?? added[0].id);
        }
      },
      onCreated: (session) => {
        setTabs((current) => (current.some((tab) => tab.id === session.id) ? current : [...current, tabFrom(session)]));
        setActiveId(session.id);
      },
      onReplay: (sessionId, data, info) => {
        write(sessionId, data, info.reset);
        setTabs((current) => current.map((tab) => (tab.id === sessionId ? { ...tab, exited: info.session.exited, exitCode: info.session.exitCode } : tab)));
      },
      onOutput: (sessionId, data) => write(sessionId, data, false),
      onExit: (sessionId, exitCode) => {
        setTabs((current) => current.map((tab) => (tab.id === sessionId ? { ...tab, exited: true, exitCode } : tab)));
      },
      onClosed: (sessionId) => {
        pending.current.delete(sessionId);
        const next = tabsRef.current.filter((tab) => tab.id !== sessionId);
        setTabs((current) => current.filter((tab) => tab.id !== sessionId));
        setActiveId((active) => (active === sessionId ? next[next.length - 1]?.id ?? null : active));
      },
      onError: (code) => showError(code),
    });
    clientRef.current = client;
    client.connect();
    return () => {
      clientRef.current = null;
      client.disconnect();
    };
  }, [write, showError]);

  const onPaneReady = useCallback((sessionId: string, handle: XtermHandle) => {
    handles.current.set(sessionId, handle);
    const queued = pending.current.get(sessionId);
    if (queued) {
      pending.current.delete(sessionId);
      if (queued.reset) handle.term.reset();
      for (const chunk of queued.chunks) handle.term.write(chunk);
    }
  }, []);
  const onPaneDispose = useCallback((sessionId: string) => { handles.current.delete(sessionId); }, []);
  const onInput = useCallback((sessionId: string, data: string) => clientRef.current?.input(sessionId, data), []);
  const onResize = useCallback((sessionId: string, cols: number, rows: number) => clientRef.current?.resize(sessionId, cols, rows), []);

  const createSession = () => {
    setError(null);
    const active = activeId ? handles.current.get(activeId) : null;
    clientRef.current?.create(shellId || null, active?.term.cols ?? 80, active?.term.rows ?? 24);
  };

  const closeSession = (sessionId: string) => {
    const tab = tabs.find((item) => item.id === sessionId);
    if (tab?.exited) {
      // 已经退出的会话：服务端可能已经回收，本地直接收掉。
      clientRef.current?.detach(sessionId);
      const next = tabs.filter((item) => item.id !== sessionId);
      setTabs(next);
      setActiveId((active) => (active === sessionId ? next[next.length - 1]?.id ?? null : active));
      return;
    }
    clientRef.current?.close(sessionId);
  };

  const open = state === 'open';

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-200">
          <Badge tone={STATE_TONE[state]}>{t(`terminal.ui.connection.${state}`)}</Badge>
          <div className="flex-1 min-w-0" />
          <select
            value={shellId}
            onChange={(event) => setShellId(event.target.value)}
            className={`${inputClass} !w-auto !py-1.5 !px-3`}
            aria-label={t('terminal.ui.shell')}
            disabled={!open || shells.length === 0}
          >
            {shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.label}{shell.isDefault ? ` · ${t('terminal.ui.defaultShell')}` : ''}</option>)}
          </select>
          <Button size="sm" variant="primary" onClick={createSession} disabled={!open}>
            <Plus className="w-3.5 h-3.5" />
            {t('terminal.ui.newSession')}
          </Button>
        </div>
        {tabs.length > 0 && (
          <div className="flex items-stretch overflow-x-auto border-b border-gray-200 bg-gray-50" role="tablist">
            {tabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-xs border-r border-gray-200 shrink-0 cursor-pointer ${tab.id === activeId ? 'bg-white text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => setActiveId(tab.id)}
              >
                <span className="font-mono">{index + 1}</span>
                <span>{tab.label}</span>
                {tab.exited && <span className="text-amber-600">{t('terminal.ui.exited', { code: tab.exitCode ?? '-' })}</span>}
                <button
                  type="button"
                  className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200"
                  onClick={(event) => { event.stopPropagation(); closeSession(tab.id); }}
                  title={t('terminal.ui.closeSession')}
                  aria-label={t('terminal.ui.closeSession')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="h-[60vh] min-h-[280px]">
          {tabs.length === 0 ? (
            <div className="h-full flex items-center justify-center px-4 text-center text-sm text-gray-400">
              {state === 'open' ? t('terminal.ui.noSessions') : state === 'unauthorized' ? t('terminal.ui.connection.unauthorized') : <LoadingRow />}
            </div>
          ) : tabs.map((tab) => (
            <XtermPane
              key={tab.id}
              sessionId={tab.id}
              active={tab.id === activeId}
              onReady={onPaneReady}
              onDispose={onPaneDispose}
              onInput={onInput}
              onResize={onResize}
            />
          ))}
        </div>
      </Card>
      <p className="text-xs text-gray-500">{t('terminal.ui.lifecycleHint')}</p>
      <AuditSection language={i18n.language} />
    </div>
  );
}

function AuditSection({ language }: { language: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<TerminalAuditEntry[] | null>(null);

  const load = useCallback(async () => {
    setEntries(null);
    const result = await readApi<{ entries: TerminalAuditEntry[] }>(terminalApi.audit(100)).catch(() => null);
    setEntries(result?.ok ? result.data.entries : []);
  }, []);

  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  const rows = useMemo(() => entries ?? [], [entries]);

  return (
    <Card>
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" className="flex items-center gap-1.5 text-sm font-semibold text-gray-900" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          {t('terminal.ui.audit.title')}
        </button>
        <div className="flex-1" />
        {expanded && (
          <Button size="sm" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            {t('control.common.refresh')}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-gray-100">
          <p className="px-4 pt-3 text-xs text-gray-500">{t('terminal.ui.audit.description')}</p>
          {entries === null ? <LoadingRow /> : rows.length === 0 ? <div className="p-4"><EmptyState>{t('terminal.ui.audit.empty')}</EmptyState></div> : (
            <div className="overflow-x-auto">
              <table className="min-w-[640px] w-full text-xs">
                <thead className="text-gray-500 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.time')}</th>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.user')}</th>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.event')}</th>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.shell')}</th>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.session')}</th>
                    <th className="px-4 py-2 font-medium">{t('terminal.ui.audit.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-gray-50">
                      <td className="px-4 py-1.5 text-gray-500 whitespace-nowrap">{formatTime(row.ts, language)}</td>
                      <td className="px-4 py-1.5 text-gray-700">{row.username ?? t('terminal.ui.audit.implicitOwner')}</td>
                      <td className="px-4 py-1.5 text-gray-700 whitespace-nowrap">{t(`terminal.ui.auditEvent.${row.event}`, { defaultValue: row.event })}</td>
                      <td className="px-4 py-1.5 font-mono text-gray-500">{row.shell ?? ''}</td>
                      <td className="px-4 py-1.5 font-mono text-gray-500">{row.sessionId ? row.sessionId.slice(0, 8) : ''}</td>
                      <td className="px-4 py-1.5 text-gray-500 break-all">{row.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
