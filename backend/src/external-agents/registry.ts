/**
 * 外部运行时清单：界面据此决定「这台主机上能不能选 claude-code」。
 *
 * `id` 与 `group_members.runtime` 存的是**同一套取值**。两套取值迟早分家——
 * 界面写 `claude_code`、库里存 `claude-code`，而分家的症状是「选了但不生效」，
 * 本仓库正为这个形状栽过（v1.3.0：选了 Claude Code，回话的是 DeepSeek，无报错）。
 */
export interface ExternalRuntimeDescriptor {
  id: string;
  /** 需要主机上有哪个可执行文件。 */
  binary: string;
  /** 中文可读名，界面直接用，不必自己拼。 */
  label: string;
  /** 目前只有 claude-code 在真机上验到过端到端往返，其余标未验证。 */
  verified: boolean;
}

export const EXTERNAL_RUNTIMES: readonly ExternalRuntimeDescriptor[] = [
  { id: 'claude-code', binary: 'claude', label: 'Claude Code', verified: true },
  { id: 'codex', binary: 'codex', label: 'Codex CLI', verified: false },
  { id: 'pi', binary: 'pi', label: 'Pi', verified: false },
];

export interface ExternalRuntimeStatus extends ExternalRuntimeDescriptor {
  available: boolean;
  /**
   * 这次探测发生的时刻。
   *
   * 留这一格是因为**探测结果有半衰期**：外部 CLI 会自己升级、被卸载、被换路径。
   * 界面可以据此显示「检测于 X 分钟前 · 重新检测」，而不是把一个可能已经过期的
   * 结论当成事实摆着——那正是 `cliBackendBinaryMissing` 那条不变量要防的形状。
   */
  probedAt: string;
}

/**
 * 探测器由调用方注入（生产里是沿 PATH 找文件那一个）。
 *
 * **不 shell out。** 起进程的成败取决于谁的 PATH 在前——生产机上
 * `openclaw --version` 就因此退出码 1，而我们要问的只是「这个文件在不在」。
 * `openclaw-version.ts` 当初就是为这个理由不 shell out 的，这里沿用同一条判据。
 */
export function buildExternalRuntimeList(
  binaryExists: (binary: string) => boolean,
): ExternalRuntimeStatus[] {
  const probedAt = new Date().toISOString();
  return EXTERNAL_RUNTIMES.map((runtime) => {
    let available = false;
    try {
      available = binaryExists(runtime.binary);
    } catch {
      // 某个 PATH 目录不可读，不该让「有哪些运行时」这个问题变成 500。
      available = false;
    }
    return { ...runtime, available, probedAt };
  });
}
