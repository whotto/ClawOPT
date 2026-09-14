import path from 'path';
import os from 'os';
import fs from 'fs';

import { writeJsonAtomicSync } from '../core/files';
import { getOpenClawConfigPath, readOpenClawConfigSafe } from './openclaw-config';

export function getExecApprovalsPath() {
  return path.join(os.homedir(), '.openclaw', 'exec-approvals.json');
}

export function readOpenClawConfig(): any | null {
  try {
    const configPath = getOpenClawConfigPath();
    if (!fs.existsSync(configPath)) {
      return null;
    }
    return readOpenClawConfigSafe();
  } catch (error) {
    return null;
  }
}

export function writeOpenClawConfig(config: any) {
  const configPath = getOpenClawConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonAtomicSync(configPath, config);
}
