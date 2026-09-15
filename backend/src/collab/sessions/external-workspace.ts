import fs from 'fs';
import path from 'path';

import { clawoptDataDir } from '../../core/paths';

/**
 * 外部运行时单聊没配工作目录时的缺省工作区：ClawOPT 数据目录下按会话 id 一个目录
 * （不在 ~/.openclaw 里造目录：这个会话不是 OpenClaw Agent）。发送一轮与分叉都按它算，只有这一份。
 */
export function externalSessionDefaultWorkspace(sessionId: string): string {
  const dir = path.join(clawoptDataDir, 'workspaces', 'external', sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
