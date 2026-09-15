/**
 * 侧栏与完成提醒用的「我看得见的单聊会话在不在跑、上一轮怎么结束」。
 *
 * 主通道是 `/ws` 的 `agent:<id>` 主题（运行生命周期事件）；这个接口是 WebSocket 连不上时的**轮询兜底**，
 * 所以只回廉价的标量：协调器里是否有活跃运行 + `run_sessions` 行上的运行计数与结束标记。
 * 结束标记只在队列排空时写（协调器 finalize），`end_reason = abort` 覆盖用户停止与「立即插入」打断——
 * 提醒据此把中断与失败分开，不把打断当失败响铃。
 */
import type { RunSessionRow } from '../../core/db';

export type SessionActivity = {
  sessionId: string;
  running: boolean;
  runCount: number;
  endedAt: string | null;
  endReason: string | null;
};

export function buildSessionActivity(
  sessionIds: string[],
  deps: { isBusy: (sessionId: string) => boolean; getRunSession: (sessionId: string) => RunSessionRow | undefined },
): SessionActivity[] {
  return sessionIds.map((sessionId) => {
    const row = deps.getRunSession(sessionId);
    return {
      sessionId,
      running: deps.isBusy(sessionId),
      runCount: row?.run_count ?? 0,
      endedAt: row?.ended_at ?? null,
      endReason: row?.end_reason ?? null,
    };
  });
}
