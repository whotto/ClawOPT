/**
 * 群里外部成员（路线 B）的一次运行，交给运行协调器驱动时用到的表面约定。
 *
 * - 会话键 `room:<群>:member:<成员>`：同一个成员在不同群里是不同的协调器会话，与 external_sessions 的主键一致；
 * - 主题：`room:<群>`（房间里所有人看得见）+ `agent:<sender_id>`（按 Agent 看活动）；
 * - 投影器：只管这一条群消息行与群聊的 legacy 帧（经引擎事件发出，房间的 SSE 与 WS 都从实时中枢取）。
 *
 * 行为与迁移前的 `runExternalMember` 逐项一致：增量推累计全文、成功落最终文本、失败落可分辨的原因。
 */
import type { DB } from '../../core/db';
import type { AdapterRunOutcome, ProjectorRunContext, RunProjector } from '../../runtime';
import { buildRoomFrame, ROOM_FRAME_EVENT } from './room-frames';

export function externalMemberSessionKey(groupId: string, memberId: string): string {
  return `room:${groupId}:member:${memberId}`;
}

export function roomTopic(groupId: string): string {
  return `room:${groupId}`;
}

export function agentTopic(agentId: string): string {
  return `agent:${agentId}`;
}

export type ExternalMemberMessagePayload = {
  groupId: string;
  id: number;
  parent_id?: number;
  sender_type: 'agent';
  sender_id: string;
  sender_name: string;
  model_used: string;
  created_at: string;
};

export type ExternalMemberProjectorDeps = {
  db: Pick<DB, 'updateGroupMessage' | 'setGroupMessageRunMarker'>;
  emit: (event: 'delta' | 'edit', payload: Record<string, unknown>) => void;
  run: ProjectorRunContext;
  basePayload: ExternalMemberMessagePayload;
  displayName: string;
  modelTag: string;
};

export function describeExternalFailure(outcome: AdapterRunOutcome): string {
  if (outcome.kind === 'aborted') return 'aborted';
  if (outcome.kind === 'failed') {
    // 编码类运行时（`runtime.*`）的详情已在适配器里脱敏（stderr 尾巴、上游原话），比码更能说清「为什么」；
    // 其余有码的失败（远程 OpenClaw 连不上、没配令牌……）只报码：原话可能带对面主机的地址与路径。
    if (outcome.code && !outcome.code.startsWith('runtime.')) return outcome.code;
    return outcome.error || outcome.code || 'unknown';
  }
  return 'unknown';
}

export function createExternalMemberProjector(deps: ExternalMemberProjectorDeps): RunProjector & { text(): string } {
  const { db, emit, run, basePayload, displayName, modelTag } = deps;
  let accumulated = '';
  db.setGroupMessageRunMarker(basePayload.id, run.runMarker);

  return {
    text: () => accumulated,
    onEvent(event) {
      if (event.type !== 'response.output_text.delta' || !event.delta) return;
      accumulated += event.delta;
      emit('delta', { ...basePayload, content: accumulated, process_content: '', process_streaming: true });
    },
    finish(outcome) {
      if (outcome.kind === 'completed') {
        const finalText = outcome.outputText ?? accumulated;
        db.updateGroupMessage(basePayload.id, finalText, modelTag, undefined, '');
        emit('edit', { ...basePayload, content: finalText, process_content: '', process_streaming: false });
        return { messageId: basePayload.id, output: finalText };
      }
      // 失败不删行，只写原因——行留着，排障才看得到「上次为什么失败」。
      const detail = describeExternalFailure(outcome);
      const message = `${displayName} 执行失败（${detail}）`;
      db.updateGroupMessage(basePayload.id, message, modelTag, undefined, '');
      emit('edit', { ...basePayload, content: message, process_content: '', process_streaming: false });
      return { messageId: basePayload.id, error: detail };
    },
    attachSnapshot() {
      return [{
        type: ROOM_FRAME_EVENT,
        payload: buildRoomFrame('delta', { ...basePayload, content: accumulated, process_content: '', process_streaming: true }),
      }];
    },
  };
}
