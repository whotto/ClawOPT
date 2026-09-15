/**
 * 成长轨迹（P6，spec 05 F39 的 ClawOPT 版）：从 Agent 工作区 MEMORY.md 的日期小节、skills 目录、写入审批记录与记忆卡片
 * 自己算出节点与边，不依赖引擎命令。
 *
 * 骨架：实现随 P6 补齐。
 */
export type JourneyGraph = {
  agentId: string;
  nodes: unknown[];
  edges: unknown[];
};

export function createJourneyService(_deps: Record<string, unknown>) {
  return {
    async graph(agentId: string): Promise<JourneyGraph> {
      return { agentId, nodes: [], edges: [] };
    },
  };
}

export type JourneyService = ReturnType<typeof createJourneyService>;
