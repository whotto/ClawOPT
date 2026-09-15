// 会话列表里只取 OpenClaw Agent 的会话：外部运行时单聊（`externalRuntime` 非空）不是 OpenClaw Agent——
// 没有工作区身份文件、头像、写入审批，也不能作为 OpenClaw 成员加进群（外部成员按成员的运行时选择加）。
// Agent 管理页、建群 / 编辑群的成员选择、用户页的 OpenClaw 授权选项都按这一处过滤。
export function openclawSessionsOnly<T>(sessions: T[]): T[] {
  return sessions.filter((session) => !(session as { externalRuntime?: string | null }).externalRuntime);
}
