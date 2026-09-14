import fs from 'fs';
import path from 'path';

export const OPENCLAW_AGENT_BOOTSTRAP_FILES = [
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'AGENTS.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

export function readAgentBootstrapContextFromWorkspace(workspacePath: string): string {
  return OPENCLAW_AGENT_BOOTSTRAP_FILES
    .map((filename) => {
      const filePath = path.join(workspacePath, filename);
      if (!fs.existsSync(filePath)) return '';
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        return content ? `# ${filename}\n${content}` : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
