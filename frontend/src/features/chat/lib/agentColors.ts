// 群聊成员头像底色：按成员在群里的位置轮换。
import type { GroupChat } from './types';

const AGENT_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-orange-500',
  'bg-pink-500', 'bg-teal-500', 'bg-indigo-500', 'bg-amber-500',
];

export function getAgentColor(agentId: string, members: GroupChat['members']): string {
  const idx = members.findIndex(m => m.agent_id === agentId);
  return AGENT_COLORS[idx % AGENT_COLORS.length] || AGENT_COLORS[0];
}
