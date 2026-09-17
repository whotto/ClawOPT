// 一个会话的 xterm 视图：挂载时建终端并交给父组件（父组件负责把重放 / 输出写进来），尺寸变化时自适应并上报。
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

export type XtermHandle = { term: Terminal; fit: () => void };

const THEME = {
  background: '#171c24',
  foreground: '#e6e9ef',
  cursor: '#e6e9ef',
  selectionBackground: '#3a6bd466',
};

export function XtermPane({ sessionId, active, onReady, onDispose, onInput, onResize }: {
  sessionId: string;
  active: boolean;
  onReady: (sessionId: string, handle: XtermHandle) => void;
  onDispose: (sessionId: string) => void;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<XtermHandle | null>(null);
  const callbacks = useRef({ onInput, onResize });
  callbacks.current = { onInput, onResize };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      theme: THEME,
      convertEol: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    let lastSize = '';
    const fit = () => {
      // 隐藏的标签（display:none）量不出尺寸：跳过，切过来时再算。
      if (!container.offsetWidth || !container.offsetHeight) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize) {
        lastSize = size;
        callbacks.current.onResize(sessionId, term.cols, term.rows);
      }
    };
    const dataListener = term.onData((data) => callbacks.current.onInput(sessionId, data));
    const observer = new ResizeObserver(() => fit());
    observer.observe(container);
    const handle = { term, fit };
    handleRef.current = handle;
    onReady(sessionId, handle);
    fit();
    return () => {
      observer.disconnect();
      dataListener.dispose();
      handleRef.current = null;
      onDispose(sessionId);
      term.dispose();
    };
    // 终端实例跟随会话 id 的一生：回调走 ref，不因父组件重渲染重建终端。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const handle = handleRef.current;
    if (!handle) return;
    handle.fit();
    handle.term.focus();
  }, [active]);

  return (
    <div
      className={`${active ? 'block' : 'hidden'} h-full w-full px-2 py-1.5`}
      style={{ backgroundColor: THEME.background }}
      data-testid={`terminal-pane-${sessionId}`}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
