/**
 * 过渡用的平台实现：只为让本分支在共享平台（feat/p2-platform）合并之前能真跑 global 模式。
 *
 * **合并平台分支时整个文件删掉**，bootstrap 改为注入平台的 ProviderProxy / McpInjector / RuntimeManager。
 * 它刻意只做最小的事：
 * - 运行时管理器：沿 PATH 找可执行文件（不 shell out）、白名单子进程环境、不做升级锁；
 * - MCP 注入：原样返回用户配置的服务，不探测；
 * - 本地模型代理：**不存在**——注册目标直接报 `runtime.modeUnsupported`，scoped 模式在平台合并前不可用。
 */
import fs from 'fs';
import path from 'path';
import type { McpInjector, ProviderProxy, RuntimeDescriptor, RuntimeManager } from './_platform-types';
import { isAllowlistedEnvName } from './_shared/env';
import { RuntimeAdapterError } from './_shared/errors';

function findOnPath(command: string, envPath: string | undefined): string | null {
  for (const dir of (envPath || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // 单个目录不可读不该让整次查找失败
    }
  }
  return null;
}

export function createInterimRuntimeManager(processEnv: NodeJS.ProcessEnv = process.env): RuntimeManager {
  const descriptors = new Map<string, RuntimeDescriptor>();
  return {
    async resolveExecutable(id) {
      const descriptor = descriptors.get(id);
      const found = descriptor ? findOnPath(descriptor.command, processEnv.PATH) : null;
      return found ? { path: found } : { missing: true, messageCode: 'runtime.notInstalled' };
    },
    childEnv(extra) {
      const env: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(processEnv)) {
        if (value !== undefined && isAllowlistedEnvName(name)) env[name] = value;
      }
      return { ...env, ...extra };
    },
    beginRun() {
      return () => {};
    },
    register(descriptor) {
      descriptors.set(descriptor.id, descriptor);
    },
  };
}

export const INTERIM_MCP_INJECTOR: McpInjector = {
  async resolveForRun({ userServers }) {
    return { servers: userServers, excluded: [] };
  },
};

export const INTERIM_PROVIDER_PROXY: ProviderProxy = {
  register() {
    throw new RuntimeAdapterError('runtime.modeUnsupported', 'scoped mode needs the local provider proxy, which is not installed on this build');
  },
  onCanonicalEvent() {
    return () => {};
  },
};
