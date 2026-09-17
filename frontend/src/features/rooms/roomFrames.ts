/**
 * 群协作帧（P3）：群事件流里除消息 / 增量 / 运行态以外的 `{ type, data }` 帧。
 * 群聊页的事件流（useGroupEvents）不认识它们，只转发成窗口事件；协作层（useRoomCollab）按群 id 订阅。
 * `interactions` / `pairing` 帧只说「变了」，内容经 HTTP 按身份取。
 */
export const ROOM_COLLAB_FRAME_TYPES = [
  'queue', 'handoff', 'summary', 'message_retracted', 'message_meta', 'interactions', 'workspace_diff', 'pairing', 'agents', 'room_updated', 'notice',
] as const;

export type RoomCollabFrameType = typeof ROOM_COLLAB_FRAME_TYPES[number];
export type RoomCollabFrame = { type: RoomCollabFrameType; data: any };

export const ROOM_FRAME_EVENT = 'clawopt:room-frame';

export function isRoomCollabFrame(value: unknown): value is RoomCollabFrame {
  return !!value && typeof value === 'object'
    && (ROOM_COLLAB_FRAME_TYPES as readonly string[]).includes((value as { type?: unknown }).type as string)
    && 'data' in (value as object);
}

export function dispatchRoomFrame(groupId: string, frame: RoomCollabFrame): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ROOM_FRAME_EVENT, { detail: { groupId, frame } }));
}

export function subscribeRoomFrames(groupId: string, listener: (frame: RoomCollabFrame) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ groupId: string; frame: RoomCollabFrame }>).detail;
    if (detail?.groupId === groupId) listener(detail.frame);
  };
  window.addEventListener(ROOM_FRAME_EVENT, handler);
  return () => window.removeEventListener(ROOM_FRAME_EVENT, handler);
}
