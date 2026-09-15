/**
 * 托管指令块：ClawOPT 往指令文件里写的内容夹在一对标记之间，
 * 更新时原地替换那一段，块外（用户自己写的指令）一个字不动。
 */
export const MANAGED_PROMPT_BEGIN = '<!-- BEGIN CLAWOPT PROMPT -->';
export const MANAGED_PROMPT_END = '<!-- END CLAWOPT PROMPT -->';

export function managedPromptBlock(prompt: string): string {
  return `${MANAGED_PROMPT_BEGIN}\n${prompt.trim()}\n${MANAGED_PROMPT_END}`;
}

/** 有块就原地换；没有就追加在用户内容之后；prompt 为空时去掉旧块。 */
export function upsertManagedPrompt(existing: string, prompt: string): string {
  const start = existing.indexOf(MANAGED_PROMPT_BEGIN);
  const end = start >= 0 ? existing.indexOf(MANAGED_PROMPT_END, start) : -1;
  const block = prompt.trim() ? managedPromptBlock(prompt) : '';
  if (start >= 0 && end >= 0) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MANAGED_PROMPT_END.length);
    const joined = `${before}${block}${after}`;
    return block ? joined : joined.replace(/\n{3,}/g, '\n\n').trim() + (joined.trim() ? '\n' : '');
  }
  if (!block) return existing;
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** 这一轮的指令：群聊的系统提示**替换**基础提示；调用方追加的指令放最后。 */
export function composeInstructions(input: { systemPrompt?: string; groupSystemPrompt?: string; instructions?: string }): string {
  const base = input.groupSystemPrompt?.trim() ? input.groupSystemPrompt.trim() : (input.systemPrompt?.trim() ?? '');
  return [base, input.instructions?.trim() ?? ''].filter(Boolean).join('\n\n');
}
