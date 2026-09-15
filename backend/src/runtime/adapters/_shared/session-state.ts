/**
 * 原生会话续话判定。
 *
 * 两条规矩（spec 04 §5.3 / §5.4）：
 *
 * 1. **预生成、确认后才续。** 允许客户端指定会话 id 的运行时，首轮用 `--session-id <预生成>`；
 *    只有 CLI 在输出里确认过这个 id（或 home 里记着它已确认），下一轮才换成 `--resume`——
 *    「用这个 id 新建」和「续这个 id」是两个不同的 CLI 操作，拿没建成的 id 去 resume 会永久失败。
 * 2. **兼容才续。** 运行时、模式相同；scoped 下 provider / model / apiMode 也要相同。
 *    scoped 下换了模型就开新的原生会话（工作区不变）——拿着旧模型的原生历史去喂新模型，
 *    轻则缓存全废，重则上游拒收（加密思维块）。
 *
 * 映射记在运行时 home 的 `.clawopt-session.json`：表面（external_sessions）只存 ClawOPT 的会话句柄，
 * 「句柄 → 原生 id + 创建时的坐标」由适配器自己记——Codex / OpenCode / DSH / Hermes 的原生 id
 * 只能从输出里观察到，表面不必知道这些差别。
 */
import path from 'path';
import type { ProxyMode } from '../../contract';
import type { RuntimeFs } from './runtime-fs';
import type { CodingAgentRunRequest } from './types';

export const SESSION_STATE_FILE = '.clawopt-session.json';

export interface LaunchFingerprint {
  runtime: string;
  mode: ProxyMode;
  provider?: string;
  model?: string;
  apiMode?: string;
}

export interface SessionState {
  version: 1;
  /** ClawOPT 会话句柄。 */
  sessionId: string;
  nativeSessionId: string | null;
  /** CLI 在输出里确认过 nativeSessionId。 */
  confirmed: boolean;
  fingerprint: LaunchFingerprint;
  updatedAt: string;
}

export type NativeSessionIdPolicy = 'client' | 'observed';

export interface ResumeDecision {
  /** 续这个原生会话。 */
  resumeNativeId: string | null;
  /** 新建时使用的原生 id（仅 client 策略）；observed 策略为 null。 */
  createNativeId: string | null;
  reason: 'resume' | 'fresh' | 'incompatible' | 'unconfirmed' | 'legacy_resume' | 'handle_mismatch' | 'fork';
}

export function fingerprintFor(runtime: string, request: CodingAgentRunRequest, mode: ProxyMode): LaunchFingerprint {
  if (mode === 'scoped' && request.provider) {
    return {
      runtime,
      mode,
      provider: request.provider.provider,
      model: request.provider.model,
      apiMode: request.provider.apiMode,
    };
  }
  return { runtime, mode };
}

export function fingerprintsCompatible(stored: LaunchFingerprint, requested: LaunchFingerprint): boolean {
  if (stored.runtime !== requested.runtime || stored.mode !== requested.mode) return false;
  if (requested.mode === 'scoped') {
    return stored.provider === requested.provider && stored.model === requested.model && stored.apiMode === requested.apiMode;
  }
  return true;
}

export function decideResume(input: {
  policy: NativeSessionIdPolicy;
  state: SessionState | null;
  request: Pick<CodingAgentRunRequest, 'sessionId' | 'resume'>;
  fingerprint: LaunchFingerprint;
  randomUUID: () => string;
  /** 分叉来源（父归属里已确认、坐标兼容的原生会话）。只有 client 策略的运行时能用。 */
  forkSource?: { nativeSessionId: string } | null;
}): ResumeDecision {
  const { policy, state, request, fingerprint } = input;
  // 分叉：自己还没有确认过的原生会话（首轮，或首轮没跑成）时，续父会话并分叉出一个新 id；确认之后就按普通续话走。
  if (input.forkSource && policy === 'client' && !(state?.confirmed && state.nativeSessionId)) {
    const createNativeId = request.sessionId === input.forkSource.nativeSessionId ? input.randomUUID() : request.sessionId;
    return { resumeNativeId: input.forkSource.nativeSessionId, createNativeId, reason: 'fork' };
  }
  const fresh = (reason: ResumeDecision['reason']): ResumeDecision => {
    if (policy === 'observed') return { resumeNativeId: null, createNativeId: null, reason };
    // 客户端指定 id：句柄本身没被用过就用句柄；否则（兼容性变了、已被旧坐标占用）另起一个。
    const handleTaken = state?.nativeSessionId === request.sessionId && state.confirmed;
    return { resumeNativeId: null, createNativeId: handleTaken ? input.randomUUID() : request.sessionId, reason };
  };

  if (!state) {
    // 迁移前的群成员（Claude Code）只存了句柄 = 原生 id，没有 home 状态：照旧续。
    if (request.resume && policy === 'client') {
      return { resumeNativeId: request.sessionId, createNativeId: null, reason: 'legacy_resume' };
    }
    return fresh('fresh');
  }
  if (state.sessionId !== request.sessionId) {
    // 表面换了句柄（上一轮失败后重开）：旧映射作废。句柄是新的，client 策略可以直接用。
    return policy === 'observed'
      ? { resumeNativeId: null, createNativeId: null, reason: 'handle_mismatch' }
      : { resumeNativeId: null, createNativeId: request.sessionId === state.nativeSessionId ? input.randomUUID() : request.sessionId, reason: 'handle_mismatch' };
  }
  if (!fingerprintsCompatible(state.fingerprint, fingerprint)) return fresh('incompatible');
  if (!request.resume) return fresh('fresh');
  if (!state.nativeSessionId || !state.confirmed) {
    // 没确认过：client 策略沿用同一个预生成 id 再「新建」一次（上一轮可能根本没起来）。
    if (policy === 'client' && state.nativeSessionId) {
      return { resumeNativeId: null, createNativeId: state.nativeSessionId, reason: 'unconfirmed' };
    }
    return fresh('unconfirmed');
  }
  return { resumeNativeId: state.nativeSessionId, createNativeId: null, reason: 'resume' };
}

export function readSessionState(runtimeFs: RuntimeFs, homeDir: string): SessionState | null {
  const text = runtimeFs.readText(path.join(homeDir, SESSION_STATE_FILE));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== 1 || typeof parsed.sessionId !== 'string' || !parsed.fingerprint) return null;
    return parsed as SessionState;
  } catch {
    return null;
  }
}

export function writeSessionState(runtimeFs: RuntimeFs, homeDir: string, state: SessionState): void {
  runtimeFs.writeFile(path.join(homeDir, SESSION_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
