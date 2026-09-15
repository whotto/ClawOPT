/**
 * 性能监控（P6，spec 07 §2.25）。骨架：实现随 P6 补齐。
 */
export function createPerformanceService(_deps: Record<string, unknown>) {
  return {
    async snapshot(): Promise<Record<string, unknown>> {
      return {};
    },
  };
}

export type PerformanceService = ReturnType<typeof createPerformanceService>;
