/**
 * 群聊 legacy 帧的唯一构造处。
 *
 * 引擎事件（message / delete / delta / edit / typing / typing_done / run_state）变成前端认的帧，
 * 以前在 room-engine.ts 里每个事件各写一遍、直接 `res.write` 给 SSE 客户端。
 * 现在帧先进实时中枢（主题 `room:<群>`，类型 `room.frame`），SSE 与 WebSocket 都从那里取；
 * 协调器接回快照里的帧也走这里——三处拼帧不许分家。
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
