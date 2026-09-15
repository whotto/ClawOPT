/**
 * 每用户主题（P6，spec 07 §2.28、spec 08 §1.6）。骨架：实现随 P6 补齐。
 */
export function createThemeService(_deps: Record<string, unknown>) {
  return {
    get(_userKey: string): Record<string, unknown> {
      return {};
    },
  };
}

export type ThemeService = ReturnType<typeof createThemeService>;
