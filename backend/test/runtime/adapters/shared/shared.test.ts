/**
 * 适配器共用件：环境白名单、续话判定、运行时 home、托管指令块、TOML 过滤、JSON-RPC、文本合成、错误码与三语文案。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../../../src/runtime/adapters/_shared/env';
import { RUNTIME_MESSAGE_CODES, detectGatewayErrorText } from '../../../../src/runtime/adapters/_shared/errors';
import { JsonRpcPeer } from '../../../../src/runtime/adapters/_shared/jsonrpc';
import { composeInstructions, upsertManagedPrompt } from '../../../../src/runtime/adapters/_shared/managed-prompt';
import { sanitizeRuntimeText } from '../../../../src/runtime/adapters/_shared/sanitize';
import { decideResume, type SessionState } from '../../../../src/runtime/adapters/_shared/session-state';
import { filterToml } from '../../../../src/runtime/adapters/_shared/toml';
import { TurnEmitter, truncateToolOutput } from '../../../../src/runtime/adapters/_shared/turn';
import { CODING_AGENT_DEFINITIONS } from '../../../../src/runtime/adapters/registry';
import { EXTERNAL_RUNTIMES } from '../../../../src/runtime/adapters/runtime-list';
import { runtimeHomePath } from '../../../../src/runtime/manager/runtime-homes';
import { fakeManager } from '../_helpers/harness';

describe('子进程环境白名单', () => {
  const processEnv = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', SECRET: 's', ANTHROPIC_API_KEY: 'k', CLAWOPT_AUTH: 'x' };

  it('scoped：只有白名单与启动变量', () => {
    const env = buildChildEnv({ mode: 'scoped', manager: fakeManager(), launchEnv: { CODEX_HOME: '/r' }, processEnv, globalCredentialEnv: [/^ANTHROPIC_/] });
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH']);
  });

  it('global：额外放行运行时声明的凭据变量，其余照样挡住', () => {
    const env = buildChildEnv({ mode: 'global', manager: fakeManager(), launchEnv: {}, processEnv, globalCredentialEnv: [/^ANTHROPIC_/] });
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.SECRET).toBeUndefined();
    expect(env.CLAWOPT_AUTH).toBeUndefined();
  });

  it('**证明会红**：管理器把整份环境合并进来，结果仍然只有白名单', () => {
    const manager = fakeManager();
    manager.leakyEnv = processEnv;
    const env = buildChildEnv({ mode: 'scoped', manager, launchEnv: {}, processEnv, globalCredentialEnv: [] });
    expect(env.SECRET).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LC_ALL).toBe('C');
  });
});

describe('续话判定', () => {
  const uuid = () => 'fresh-uuid';
  const fp = { runtime: 'claude-code', mode: 'scoped' as const, provider: 'p', model: 'm', apiMode: 'responses' };
  const state = (over: Partial<SessionState> = {}): SessionState => ({ version: 1, sessionId: 'h1', nativeSessionId: 'h1', confirmed: true, fingerprint: fp, updatedAt: '', ...over });

  it('兼容且确认过 → 续', () => {
    expect(decideResume({ policy: 'client', state: state(), request: { sessionId: 'h1', resume: true }, fingerprint: fp, randomUUID: uuid }))
      .toEqual({ resumeNativeId: 'h1', createNativeId: null, reason: 'resume' });
  });

  it('scoped 换 provider / model / apiMode 任一项 → 不续；client 策略另起新 id（旧 id 已被占用）', () => {
    for (const change of [{ provider: 'q' }, { model: 'n' }, { apiMode: 'chat_completions' }]) {
      const decision = decideResume({ policy: 'client', state: state(), request: { sessionId: 'h1', resume: true }, fingerprint: { ...fp, ...change }, randomUUID: uuid });
      expect(decision).toMatchObject({ resumeNativeId: null, createNativeId: 'fresh-uuid', reason: 'incompatible' });
    }
  });

  it('模式变了（scoped → global）→ 不续', () => {
    expect(decideResume({ policy: 'observed', state: state(), request: { sessionId: 'h1', resume: true }, fingerprint: { runtime: 'claude-code', mode: 'global' }, randomUUID: uuid }).reason).toBe('incompatible');
  });

  it('global 下换模型不影响续话（CLI 用自己的配置）', () => {
    const g = { runtime: 'codex', mode: 'global' as const };
    expect(decideResume({ policy: 'observed', state: state({ fingerprint: g, nativeSessionId: 'thread-1' }), request: { sessionId: 'h1', resume: true }, fingerprint: g, randomUUID: uuid }).resumeNativeId).toBe('thread-1');
  });

  it('观察型运行时没有状态 → 新建，不拿句柄去猜', () => {
    expect(decideResume({ policy: 'observed', state: null, request: { sessionId: 'h1', resume: true }, fingerprint: fp, randomUUID: uuid }))
      .toEqual({ resumeNativeId: null, createNativeId: null, reason: 'fresh' });
  });

  it('表面换了句柄（上一轮失败后重开）→ 旧映射作废', () => {
    expect(decideResume({ policy: 'observed', state: state({ nativeSessionId: 't' }), request: { sessionId: 'h2', resume: true }, fingerprint: fp, randomUUID: uuid }).reason).toBe('handle_mismatch');
  });
});

describe('运行时 home', () => {
  it('路径由平台的 runtimeHomePath 给：群聊按 (群, 成员) 稳定且互不相同，单聊按会话；运行时 id 不合法抛错', () => {
    const a = runtimeHomePath('/d/runtime', 'codex', { kind: 'room-member', groupId: 'room/1', memberId: 'm 1' });
    expect(a).toBe(runtimeHomePath('/d/runtime', 'codex', { kind: 'room-member', groupId: 'room/1', memberId: 'm 1' }));
    expect(a).not.toBe(runtimeHomePath('/d/runtime', 'codex', { kind: 'room-member', groupId: 'room/1', memberId: 'm 2' }));
    expect(runtimeHomePath('/d/runtime', 'pi', { kind: 'session', sessionId: 's' })).toMatch(/^\/d\/runtime\/pi\/[0-9a-f]{24}$/);
    expect(() => runtimeHomePath('/d/runtime', '../x', { kind: 'session', sessionId: 's' })).toThrow();
  });
});

describe('托管指令块', () => {
  it('原地替换、块外内容不动、空提示去掉旧块', () => {
    const first = upsertManagedPrompt('# 用户自己的\n', '规则 A');
    expect(first).toContain('# 用户自己的');
    const second = upsertManagedPrompt(first, '规则 B');
    expect(second).toContain('规则 B');
    expect(second).not.toContain('规则 A');
    expect(second.startsWith('# 用户自己的')).toBe(true);
    expect(upsertManagedPrompt(second, '')).not.toContain('CLAWOPT PROMPT');
  });

  it('群聊系统提示替换基础提示，追加指令在后', () => {
    expect(composeInstructions({ systemPrompt: 'base', groupSystemPrompt: 'group', instructions: 'extra' })).toBe('group\n\nextra');
    expect(composeInstructions({ systemPrompt: 'base' })).toBe('base');
  });
});

describe('TOML 过滤', () => {
  it('去掉运行时自己管的键与段；多行数组与多行字符串不被切开', () => {
    const input = [
      'model = "gpt-x"',
      'approval_policy = "never"',
      'notify = [',
      '  "a",',
      '  "[not a header]",',
      ']',
      'developer_instructions = """',
      '[also not a header]',
      '"""',
      '',
      '[model_providers.custom]',
      'base_url = "https://x"',
      '',
      '[mcp_servers.old]',
      'command = "x"',
      '',
      '[projects."/work"]',
      'trust_level = "trusted"',
    ].join('\n');
    const out = filterToml(input, {
      dropTopLevelKeys: new Set(['model', 'developer_instructions']),
      dropSection: (h) => h.startsWith('model_providers') || h.startsWith('mcp_servers'),
    });
    expect(out).toContain('approval_policy = "never"');
    expect(out).toContain('"[not a header]",');
    expect(out).not.toContain('also not a header');
    expect(out).not.toContain('gpt-x');
    expect(out).not.toContain('base_url');
    expect(out).not.toContain('mcp_servers');
    expect(out).toContain('[projects."/work"]');
  });
});

describe('JSON-RPC', () => {
  it('请求关联、通知分发、服务端请求回写结果、关闭时挂起的请求失败', async () => {
    const written: any[] = [];
    const notes: string[] = [];
    const peer = new JsonRpcPeer({
      write: (line) => written.push(JSON.parse(line)),
      onNotification: (method) => notes.push(method),
      onRequest: (method) => (method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'allow_once' } } : undefined),
    });
    const pending = peer.request('initialize', { protocolVersion: 1 });
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: written[0].id, result: { ok: true } }));
    expect(await pending).toEqual({ ok: true });
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }));
    expect(notes).toEqual(['session/update']);
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} }));
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(written[1]).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
    expect(written[2].error.code).toBe(-32601);
    const hanging = peer.request('session/prompt', {});
    peer.close('gone');
    await expect(hanging).rejects.toThrow('gone');
    expect(peer.handleLine('not json')).toBe(false);
  });
});

describe('文本合成', () => {
  it('累计快照转增量、工具边界之后另起消息并以空行分隔、同一 call id 只开一次', () => {
    const events: any[] = [];
    const emitter = new TurnEmitter('r1', (e) => events.push(e.event));
    emitter.textChunk('Hello');
    emitter.textChunk('Hello world, this is a long snapshot');
    emitter.toolStarted({ callId: 'c1', name: 'bash', args: { command: 'ls' } });
    emitter.toolStarted({ callId: 'c1', name: 'bash' });
    emitter.toolCallDone({ callId: 'c1', name: 'bash' });
    emitter.toolOutput({ callId: 'c1', output: 'x'.repeat(40_000) });
    emitter.textDelta('ok');
    emitter.completed();
    expect(emitter.text).toBe('Hello world, this is a long snapshot\n\nok');
    expect(events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'message')).toHaveLength(2);
    const output = events.find((e) => e.item?.type === 'function_call_output');
    expect(output.item.output.length).toBeLessThan(40_000);
    expect(events.at(-1)).toMatchObject({ type: 'response.completed', output_text: emitter.text });
    expect(truncateToolOutput('short')).toBe('short');
  });

  it('终态之后的事件一律不再发出', () => {
    const events: any[] = [];
    const emitter = new TurnEmitter('r1', (e) => events.push(e.event));
    emitter.failed('boom', 'runtime.apiError');
    emitter.textDelta('late');
    emitter.completed();
    expect(events.map((e) => e.type)).toEqual(['response.created', 'response.failed']);
  });
});

describe('错误码与脱敏', () => {
  it('**每个 messageCode 在三份 locale 里都有译文**', () => {
    const dir = path.resolve(__dirname, '..', '..', '..', '..', '..', 'frontend', 'src', 'locales');
    for (const locale of ['zh-CN', 'zh-TW', 'en']) {
      const messages = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
      for (const code of RUNTIME_MESSAGE_CODES) {
        const [ns, key] = code.split('.');
        expect(typeof messages[ns]?.[key], `${locale} 缺 ${code}`).toBe('string');
      }
    }
  });

  it('网关错误文本判失败；普通回答不误判', () => {
    expect(detectGatewayErrorText('API Error: 429 rate limited')).toBe('API Error: 429 rate limited');
    expect(detectGatewayErrorText('Provider returned HTTP 502')).toBeTruthy();
    expect(detectGatewayErrorText('The API Error: 500 happened yesterday')).toBeNull();
  });

  it('脱敏：Bearer、sk- key、api_key=、代理令牌、home 路径、ANSI', () => {
    const text = sanitizeRuntimeText('[31mBearer abcdefghijklmnop sk-ant-abcdefghijkl api_key=supersecret1 clawopt_abcdefghijklmnop /Users/me/x[0m', { homeDir: '/Users/me' });
    expect(text).toBe('Bearer [redacted] sk-[redacted] api_key=[redacted] clawopt_[redacted] ~/x');
  });
});

describe('登记表', () => {
  it('每个运行时都交齐三件套（描述符、能力、仲裁表）且 id 与清单一致', () => {
    expect(EXTERNAL_RUNTIMES.map((r) => r.id)).toEqual(CODING_AGENT_DEFINITIONS.map((d) => d.descriptor.id));
    for (const definition of CODING_AGENT_DEFINITIONS) {
      expect(definition.descriptor.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(definition.capabilities.proxyMode.length).toBeGreaterThan(0);
      expect(definition.sourceOfTruth.tools).toBeTruthy();
    }
  });
});
