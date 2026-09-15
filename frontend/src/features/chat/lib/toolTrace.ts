// 工具轨迹摘要卡的数据与纯逻辑（带单测）。接口：GET /api/chat/:id/tool-calls?messageIds=。

export type WirePayload = { text: string; truncated: boolean; originalLength: number; format: 'json' | 'diff' | 'text' | string };

export type ToolTraceCall = {
  id: number;
  callId: string;
  name: string;
  status: 'completed' | 'failed' | 'interrupted' | null;
  durationMs: number | null;
  preview: string;
  arguments: WirePayload;
  output: WirePayload | null;
};

export type ToolTraceRun = { messageId: number; runMarker: string; calls: ToolTraceCall[] };

/** 12s、1m 05s。 */
export function formatLiveDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function groupTracesByMessage(runs: ReadonlyArray<ToolTraceRun>): Map<string, ToolTraceRun[]> {
  const map = new Map<string, ToolTraceRun[]>();
  for (const run of runs) {
    if (!Array.isArray(run?.calls) || run.calls.length === 0) continue;
    const key = String(run.messageId);
    map.set(key, [...(map.get(key) ?? []), run]);
  }
  return map;
}

/** 「N 个工具 · 名字1 · 名字2 · 名字3 · +k」：名字按首次出现去重；失败与中断分开计数。 */
export function summarizeToolRun(calls: ReadonlyArray<Pick<ToolTraceCall, 'name' | 'status'>>, visibleNames = 3) {
  const unique: string[] = [];
  for (const call of calls) if (!unique.includes(call.name)) unique.push(call.name);
  return {
    total: calls.length,
    names: unique.slice(0, visibleNames),
    more: Math.max(0, unique.length - visibleNames),
    failed: calls.filter((call) => call.status === 'failed').length,
    interrupted: calls.filter((call) => call.status === 'interrupted').length,
  };
}
