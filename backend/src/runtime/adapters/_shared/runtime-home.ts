/**
 * 每个对话一个运行时 home：`<dataDir>/runtime/<runtime>/<hash>`。
 *
 * - 单聊（或任何按会话键运行的表面）：hash = sha256(JSON[会话键]) 取 32 位；
 * - 群聊：`<dataDir>/runtime/<runtime>/group/<slug(群)>_<sha12>/<slug(成员)>_<sha12>`——
 *   同一成员在同一群里跨轮次**稳定**，换群就是另一个 home。
 *
 * **从不重定向 HOME。** 那会连带改掉 git、ssh、npm 与子 shell 的配置来源。
 * 运行时 home 只经各 CLI 自己的指针变量生效（CODEX_HOME、GROK_HOME、PI_CODING_AGENT_DIR…）。
 */
import crypto from 'crypto';
import path from 'path';

export type ConversationScope =
  | { kind: 'session'; sessionKey: string }
  | { kind: 'group'; roomId: string; memberId: string };

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function slugSegment(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  return slug || '_';
}

export function runtimeHomeDir(dataDir: string, runtime: string, scope: ConversationScope): string {
  if (!/^[a-z][a-z0-9-]*$/.test(runtime)) throw new Error(`invalid runtime id: ${runtime}`);
  const root = path.join(dataDir, 'runtime', runtime);
  if (scope.kind === 'group') {
    return path.join(
      root,
      'group',
      `${slugSegment(scope.roomId)}_${sha256Hex(scope.roomId).slice(0, 12)}`,
      `${slugSegment(scope.memberId)}_${sha256Hex(scope.memberId).slice(0, 12)}`,
    );
  }
  return path.join(root, sha256Hex(JSON.stringify([scope.sessionKey])).slice(0, 32));
}
