/**
 * 群聊帧的唯一构造处。
 *
 * 引擎事件（message / delete / delta / edit / typing / typing_done / run_state）变成前端认的帧，
 * 以前在 room-engine.ts 里每个事件各写一遍、直接 `res.write` 给 SSE 客户端。
 * 现在帧先进实时中枢（主题 `room:<群>`，类型 `room.frame`），SSE 与 WebSocket 都从那里取；
 * 协调器接回快照里的帧也走这里——三处拼帧不许分家。
 *
 * P3 的协作帧（队列快照、交接链、摘要状态、撤回、交互变化、工作区 diff、配对请求、Agent 在线状态）同样只在这里拼。
 */
import { rewriteOpenClawMediaPaths } from '../sessions';
import { getGroupWorkspacePath } from './group-workspace';
import { withStructuredGroupMessage } from './room-messages';

export const ROOM_FRAME_EVENT = 'room.frame';

export type RoomEngineEvent = 'message' | 'delete' | 'delta' | 'edit' | 'typing' | 'typing_done' | 'run_state';

export const ROOM_ENGINE_EVENTS: readonly RoomEngineEvent[] = ['message', 'delete', 'delta', 'edit', 'typing', 'typing_done', 'run_state'];

export function buildRoomFrame(event: RoomEngineEvent, info: any): Record<string, unknown> {
  switch (event) {
    case 'message':
      return { type: 'message', data: withStructuredGroupMessage(info, { groupId: info.groupId }) };
    case 'delete':
      return { type: 'delete', id: info.id, parent_id: info.parent_id ?? null };
    case 'delta':
    case 'edit':
      return {
        type: event,
        ...info,
        content: typeof info.content === 'string'
          ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspacePath(info.groupId))
          : info.content,
      };
    case 'typing':
    case 'typing_done':
    case 'run_state':
      return { type: event, data: info };
  }
}

export type RoomCollabFrameType =
  | 'queue'
  | 'handoff'
  | 'summary'
  | 'message_retracted'
  | 'message_meta'
  | 'interactions'
  | 'workspace_diff'
  | 'pairing'
  | 'agents'
  | 'room_updated'
  | 'notice';

/** 协作帧：`{ type, data }`。`interactions` 与 `pairing` 只提醒「变了」，内容经 HTTP 按身份过滤取。 */
export function buildCollabFrame(type: RoomCollabFrameType, data: unknown): Record<string, unknown> {
  return { type, data };
}
