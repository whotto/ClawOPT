/**
 * 共享平台（本地模型代理、托管 MCP 注入、运行时管理器）的接口——**只有类型**。
 *
 * 这些实现由并行分支 feat/p2-platform 交付；适配器只按接口编码，实现经工厂注入，
 * 测试注入假实现。合并时以平台分支的定义为准：这里的每个字段与平台约定逐字一致，
 * 分家的症状是类型检查不过，而不是运行时悄悄错位。
 *
 * 不要在这个文件里写任何实现。
 */
import type { CanonicalEvent } from '../contract';

/** 平台约定里的名字；与契约里的规范事件是同一个类型。 */
export type CanonicalRuntimeEvent = CanonicalEvent;

export type ApiMode = 'chat_completions' | 'responses' | 'anthropic_messages';

export interface ProxyTarget {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  apiMode: ApiMode;
  reasoningEffort?: string;
  runtime: string;
  runId: string;
  sessionId: string;
}

export interface RegisteredProxyTarget {
  routeKey: string;
  token: string;
  anthropicBaseUrl: string;
  responsesBaseUrl: string;
  revoke(): void;
}

export interface ProviderProxy {
  register(t: ProxyTarget): RegisteredProxyTarget;
  onCanonicalEvent(runId: string, l: (e: CanonicalRuntimeEvent) => void): () => void;
}

export interface ManagedMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpInjector {
  resolveForRun(o: { runtime: string; userServers: ManagedMcpServer[] }): Promise<{
    servers: ManagedMcpServer[];
    excluded: { name: string; reason: string }[];
  }>;
}

export interface RuntimeDescriptor {
  id: string;
  name: string;
  command: string;
  npmPackage?: string;
  pipPackage?: string;
  installKind: 'npm' | 'pip' | 'manual';
  versionArgs: string[];
  officialRegistry?: boolean;
}

export interface RuntimeManager {
  resolveExecutable(id: string): Promise<{ path: string } | { missing: true; messageCode: 'runtime.notInstalled' }>;
  childEnv(extra: Record<string, string>): NodeJS.ProcessEnv;
  beginRun(id: string): () => void;
  register(d: RuntimeDescriptor): void;
}
