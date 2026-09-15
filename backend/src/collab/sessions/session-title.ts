/**
 * 运行时提议的会话标题（P1b 第 8 项）。
 *
 * 适配器把运行时起的标题转成 `session.title` 控制事件；这里是单聊表面收它的唯一一处：
 * 按 `SessionOrgStore.proposeTitle(..., 'runtime')` 的优先级写（只替换没有标题 / 自动标题 / 上一次运行时提议，
 * 手动改名永远赢），**真的改了**才在会话主题上推 `session.title.updated`，侧栏与头部据此重拉组织视图。
 */
import type { CanonicalEvent, ProjectorRunContext, RunProjector } from '../../runtime';
import type { SessionOrgStore } from './session-org-store';

export const SESSION_TITLE_EVENT = 'session.title.updated';

export function withSessionTitle(
  store: Pick<SessionOrgStore, 'proposeTitle' | 'getMeta'>,
  run: Pick<ProjectorRunContext, 'sessionKey' | 'publish'>,
  inner: RunProjector,
): RunProjector {
  return {
    onEvent(event: CanonicalEvent) {
      inner.onEvent(event);
      if (event.type !== 'session.title') return;
      try {
        const before = store.getMeta(run.sessionKey);
        const meta = store.proposeTitle(run.sessionKey, event.title, 'runtime');
        // Hermes 每轮都重发同一个标题：内容与来源都没变就不推帧。
        if (meta?.title && (meta.title !== before?.title || meta.titleSource !== before?.titleSource)) {
          run.publish(SESSION_TITLE_EVENT, { sessionId: run.sessionKey, title: meta.title, titleSource: meta.titleSource }, { replay: { mode: 'replace', key: SESSION_TITLE_EVENT } });
        }
      } catch (error) {
        console.warn(`[chat] session title update failed for ${run.sessionKey}:`, (error as Error)?.message);
      }
    },
    finish: (outcome) => inner.finish(outcome),
    attachSnapshot: inner.attachSnapshot ? () => inner.attachSnapshot!() : undefined,
  };
}
