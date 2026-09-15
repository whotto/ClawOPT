/**
 * 用录制的 ACP 往返扮演对端（DSH / Hermes）。
 *
 * 录制文件每行 `{dir: "->" | "<-", msg}`。适配器每发一个请求，就找录制里下一个同方法的请求，
 * 把它与其应答之间对端发出的全部消息（通知、对端发起的请求、应答）按顺序回放，应答 id 换成适配器这次用的 id。
 * 录制里没有的方法（例如某次录制没发 session/close）回空结果。
 */
import fs from 'fs';
import path from 'path';
import type { FakeProcess } from './harness';

interface Recorded { dir: '->' | '<-'; msg: any }

export function loadAcpFixture(runtimeDir: string, name: string): Recorded[] {
  return fs.readFileSync(path.join(__dirname, '..', runtimeDir, 'fixtures', name), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** 录制里第 occurrence 个 `method` 请求之后、到它的应答为止，对端发出的消息（应答放最后）。 */
export function recordedBatch(recorded: Recorded[], method: string, occurrence = 0): any[] {
  let seen = 0;
  for (let i = 0; i < recorded.length; i += 1) {
    const entry = recorded[i];
    if (entry.dir !== '->' || entry.msg.method !== method || entry.msg.id === undefined) continue;
    if (seen++ !== occurrence) continue;
    const batch: any[] = [];
    for (let j = i + 1; j < recorded.length; j += 1) {
      const next = recorded[j];
      if (next.dir === '->') {
        if (next.msg.method && next.msg.id !== undefined) break;
        continue;
      }
      batch.push(next.msg);
      if (next.msg.id === entry.msg.id && !next.msg.method) break;
    }
    return batch;
  }
  throw new Error(`no recorded ${method} #${occurrence}`);
}

export interface AcpReplay {
  /** 适配器发出的全部消息。 */
  sent: any[];
  /** 适配器对对端请求的答复（例如权限选择）。 */
  answers: any[];
}

export function replayAcp(proc: FakeProcess, recorded: Recorded[], overrides: Record<string, (msg: any) => any[] | null> = {}): AcpReplay {
  const used = new Set<number>();
  const sent: any[] = [];
  const answers: any[] = [];
  const serverRequestIds = new Set<string>();

  const batchFor = (method: string): { batch: any[]; responseIndex: number } | null => {
    for (let i = 0; i < recorded.length; i += 1) {
      const entry = recorded[i];
      if (used.has(i) || entry.dir !== '->' || entry.msg.method !== method || entry.msg.id === undefined) continue;
      used.add(i);
      const id = entry.msg.id;
      const batch: any[] = [];
      for (let j = i + 1; j < recorded.length; j += 1) {
        const next = recorded[j];
        if (next.dir === '->') {
          if (next.msg.method && next.msg.id !== undefined) break; // 下一个客户端请求：这一段结束（应答可能在更后面，但录制里是先到的）
          continue; // 客户端对对端请求的答复、通知：由适配器自己发，不回放
        }
        batch.push(next.msg);
        if (next.msg.id === id && !next.msg.method) return { batch, responseIndex: batch.length - 1 };
      }
      return { batch, responseIndex: -1 };
    }
    return null;
  };

  /** 回放到对端发起的请求（例如权限请求）就停下，等适配器答复了再继续——和真对端一样。 */
  const waitingForAnswer = new Map<string, () => void>();
  const emit = (replies: any[]) => {
    for (let index = 0; index < replies.length; index += 1) {
      const reply = replies[index];
      proc.line(reply);
      if (reply.method && reply.id !== undefined) {
        serverRequestIds.add(String(reply.id));
        const rest = replies.slice(index + 1);
        if (rest.length) waitingForAnswer.set(String(reply.id), () => setImmediate(() => emit(rest)));
        return;
      }
    }
  };

  proc.onWrite((data) => {
    for (const line of data.split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      sent.push(msg);
      if (!msg.method && msg.id !== undefined && serverRequestIds.has(String(msg.id))) {
        answers.push(msg);
        const resume = waitingForAnswer.get(String(msg.id));
        waitingForAnswer.delete(String(msg.id));
        resume?.();
        continue;
      }
      if (!msg.method || msg.id === undefined) continue;
      const override = overrides[msg.method];
      const custom = override ? override(msg) : null;
      const found = custom ? { batch: custom, responseIndex: custom.length - 1 } : batchFor(msg.method);
      const replies = found ? found.batch.map((reply, index) => (index === found.responseIndex && !reply.method ? { ...reply, id: msg.id } : reply)) : [{ jsonrpc: '2.0', id: msg.id, result: {} }];
      setImmediate(() => emit(replies));
    }
  });
  return { sent, answers };
}
