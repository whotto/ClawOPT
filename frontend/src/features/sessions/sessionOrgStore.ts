// 会话组织视图的前端状态：侧栏（分组）与聊天页头部（对话标题、分叉血缘）共用一份。
// 只读服务端；写操作走接口，成功后重拉。请求序号守卫：慢的旧响应不覆盖新的。
import { create } from 'zustand';
import {
  batchDeleteSessions, createSessionCategory, deleteSessionCategory, getSessionOrganization,
  moveSessionToCategory, renameSessionCategory, renameSessionTitle, setSessionArchived, setSessionPinned,
} from '../../api/sessions';
import { normalizeOrganization, type SessionOrganization } from './sessionOrganization';

type ActionResult = { ok: true; payload?: any } | { ok: false; payload: any };

type SessionOrgState = {
  organization: SessionOrganization | null;
  load: () => Promise<void>;
  createCategory: (name: string) => Promise<ActionResult>;
  renameCategory: (id: number, name: string) => Promise<ActionResult>;
  deleteCategory: (id: number) => Promise<ActionResult>;
  moveToCategory: (sessionId: string, categoryId: number | null) => Promise<ActionResult>;
  setArchived: (sessionId: string, archived: boolean) => Promise<ActionResult>;
  setPinned: (sessionId: string, pinned: boolean) => Promise<ActionResult>;
  renameTitle: (sessionId: string, title: string) => Promise<ActionResult>;
  batchDelete: (ids: string[]) => Promise<ActionResult>;
};

let loadSeq = 0;

async function run(request: () => Promise<Response>, after: () => Promise<void>): Promise<ActionResult> {
  try {
    const response = await request();
    const payload = await response.json().catch(() => ({}));
    await after();
    return response.ok ? { ok: true, payload } : { ok: false, payload };
  } catch (error: any) {
    return { ok: false, payload: { error: error?.message || String(error) } };
  }
}

export const useSessionOrgStore = create<SessionOrgState>((set, get) => ({
  organization: null,
  load: async () => {
    const seq = ++loadSeq;
    try {
      const response = await getSessionOrganization();
      if (!response.ok) return;
      const payload = await response.json();
      if (seq !== loadSeq) return;
      set({ organization: normalizeOrganization(payload) });
    } catch {
      // 组织视图拿不到：侧栏退回平铺列表。
    }
  },
  createCategory: (name) => run(() => createSessionCategory(name), get().load),
  renameCategory: (id, name) => run(() => renameSessionCategory(id, name), get().load),
  deleteCategory: (id) => run(() => deleteSessionCategory(id), get().load),
  moveToCategory: (sessionId, categoryId) => run(() => moveSessionToCategory(sessionId, categoryId), get().load),
  setArchived: (sessionId, archived) => run(() => setSessionArchived(sessionId, archived), get().load),
  setPinned: (sessionId, pinned) => run(() => setSessionPinned(sessionId, pinned), get().load),
  renameTitle: (sessionId, title) => run(() => renameSessionTitle(sessionId, title), get().load),
  batchDelete: (ids) => run(() => batchDeleteSessions(ids), get().load),
}));
