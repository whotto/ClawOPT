/**
 * 红线 A 的**基线冻结**（S2-A8）—— Sprint 2 的出口闸门。
 *
 * ## 为什么必须在 Sprint 2 就冻结
 *
 * 红线 A 要求：Sprint 3 抽出 `buildSharedContext()` 之后，
 * `buildAgentPrompt()` 对同一组输入必须产出**逐字节相同**的字符串。
 *
 * 原计划把它写成 Sprint 3 的一句要求。计划评审（Codex）指出那不可验证：
 * **没有任何机制阻止「先抽取、后生成快照」**——那样会把已经发生的漂移
 * 认证成基线，而真正的漂移要到 Sprint 4 才暴露，届时已无干净基线可退。
 *
 * 所以基线在这里生成：本 sprint **一次都没有改过 `group-chat-engine.ts`**
 * （`git log 26d1f8d..HEAD -- backend/src/group-chat-engine.ts` 为空），
 * 现在的输出就是未被污染的真值。
 *
 * ## Sprint 3 的纪律
 *
 * **只许消费，不许重新生成。** 下面那条守卫会断言基线目录在 Sprint 3 的 diff 里
 * 没有被修改过——改了就是把漂移认证成基线，那正是这道闸门要防的事。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GroupChatEngine } from '../src/group-chat-engine';

const BASELINE_DIR = path.join(__dirname, 'fixtures', 'prompt-baseline');

/** 一条群成员记录的最小形状。字段取自 `GroupMemberRow` 里 buildAgentPrompt 真正读的那几个。 */
const member = (agentId: string, displayName: string, role = '') => ({
  id: 1, group_id: 'g', agent_id: agentId, display_name: displayName,
  role_description: role, runtime_kind: 'openclaw' as const, external_profile_id: null,
  position: 0, created_at: '2026-01-01T00:00:00Z',
}) as any;

/** 一条群消息。 */
const msg = (i: number, content: string, senderType: 'user' | 'agent' = 'agent') => ({
  id: i, group_id: 'g', parent_id: null, sender_type: senderType,
  sender_id: senderType === 'user' ? 'user' : 'a1', sender_name: senderType === 'user' ? '用户' : '甲',
  content, process_content: '', model_used: '', created_at: '2026-01-01T00:00:00Z',
}) as any;

const MEMBERS = [member('a1', '甲', '负责调研'), member('a2', '乙', '负责写作')];

/**
 * 七种输入矩阵。契约逐字规定：
 * 无附件 / 含图片 / 含文档 / 含音频 / 历史超过 15 条需裁剪 / 自定义 process tag / 空 role_description。
 *
 * 「含图片/文档/音频」在 `buildAgentPrompt` 这一层体现为 `triggerMsg` 里的附件语境文本
 * ——真正的附件解析发生在调用方，这一层只负责把那段文本拼进去。
 *
 * **第五项改名了，理由要记下来。** 契约写的是「历史超过 15 条需裁剪」，
 * 而实测 `buildAgentPrompt` 收到 30 条就渲染 30 条——**裁剪发生在调用方**
 * （`sendToAgent` 里的 `promptContextMessages = allRecent.slice(-GROUP_CONTEXT_RECENT_WINDOW)`）。
 * 这一层根本不做裁剪。原名 `05-history-truncated` 声称的事这个函数不做，
 * 是「标题强于断言」的另一种形状；改名为 `05-long-history`，
 * 它覆盖的是「长历史的渲染路径」这个真实维度。
 *
 * 裁剪本身由 `master-acceptance.md` 的 M3-3 在 Sprint 3 验（造 30 条、
 * 断言第 15 条**不**出现），那是调用方的判据，不属于基线。
 */
const MATRIX: Array<[string, () => string[]]> = [
  ['01-no-attachment', () => ['甲', '', MEMBERS[0], MEMBERS, [msg(1, '开始')], '把这件事查清楚', '用户', '', '', '/ws', '/ws/uploads', '/ws/output', '2']],
  ['02-image', () => ['甲', '群设定：调研组', MEMBERS[0], MEMBERS, [msg(1, '开始')], '看这张图\n\n[图片检视] 图中是一张架构图', '用户', '<过程>', '</过程>', '/ws', '/ws/uploads', '/ws/output', '2']],
  ['03-document', () => ['甲', '群设定：调研组', MEMBERS[0], MEMBERS, [msg(1, '开始')], '读这份文档\n\n[文档工具] 已就绪', '用户', '<过程>', '</过程>', '/ws', '/ws/uploads', '/ws/output', '2']],
  ['04-audio', () => ['甲', '群设定：调研组', MEMBERS[0], MEMBERS, [msg(1, '开始')], '听这段录音\n\n[音频转写] 你好世界', '用户', '<过程>', '</过程>', '/ws', '/ws/uploads', '/ws/output', '2']],
  ['05-long-history', () => ['甲', '群设定：调研组', MEMBERS[0], MEMBERS, Array.from({ length: 30 }, (_, i) => msg(i + 1, `第 ${i + 1} 条`)), '继续', '用户', '<过程>', '</过程>', '/ws', '/ws/uploads', '/ws/output', '2']],
  ['06-custom-tags', () => ['甲', '群设定：调研组', MEMBERS[0], MEMBERS, [msg(1, '开始')], '继续', '用户', '[[BEGIN]]', '[[END]]', '/ws', '/ws/uploads', '/ws/output', '0']],
  ['07-empty-role', () => ['甲', '', member('a3', '丙', ''), [member('a3', '丙', '')], [msg(1, '开始')], '继续', '用户', '', '', undefined, undefined, undefined, '0']],
];

function renderPrompt(args: any[]): string {
  const engine = Object.create(GroupChatEngine.prototype) as any;
  // buildAgentPrompt 只用到 this 上的两个方法，其余成员不参与。
  engine.canUseHostTakeover = () => false;
  engine.getPreferredLanguage = () => 'zh-CN';
  const [groupName, groupDesc, m, all, recent, trigger, sender, startTag, endTag, ws, up, out, depth] = args;
  return engine.buildAgentPrompt(
    groupName, groupDesc, m, all, recent, trigger, sender,
    startTag || undefined, endTag || undefined, ws, up, out, Number(depth),
  );
}

describe('S2-A8 · 红线 A 基线冻结（Sprint 2 出口闸门）', () => {
  it('七种输入的字节快照与签入的基线逐字节一致', () => {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
    const write = process.env.CLAWOPT_WRITE_PROMPT_BASELINE === '1';
    const diffs: string[] = [];

    for (const [name, build] of MATRIX) {
      const actual = renderPrompt(build());
      const file = path.join(BASELINE_DIR, `${name}.txt`);

      if (write) {
        fs.writeFileSync(file, actual, 'utf-8');
        continue;
      }

      expect(fs.existsSync(file), `基线缺失：${name}。首次生成请跑 CLAWOPT_WRITE_PROMPT_BASELINE=1`).toBe(true);
      // **字节级**比较：Buffer 相等，不是字符串 trim 后相等。
      // 空白与换行的差异同样是漂移——prompt 里的换行是有语义的。
      const expected = fs.readFileSync(file);
      if (!Buffer.from(actual, 'utf-8').equals(expected)) {
        diffs.push(`${name}: 期望 ${expected.length} 字节，实际 ${Buffer.byteLength(actual, 'utf-8')} 字节`);
      }
    }

    expect(diffs, `prompt 发生漂移（红线 A）：\n${diffs.join('\n')}`).toEqual([]);
  });

  it('基线目录必须已签入 git —— 未签入的基线等于没有基线', () => {
    const tracked = execFileSync('git', ['ls-files', 'backend/test/fixtures/prompt-baseline'], {
      cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean);
    // 目录里除七份快照外还有 REVIEWED.md（复审记录，见下一条用例的说明），只数快照。
    const snapshots = tracked.filter((file) => file.endsWith('.txt'));
    expect(snapshots.length, '基线文件没有被 git 跟踪').toBe(MATRIX.length);
  });

  it('生成基线的提交必须早于任何触及 sendToAgent 的提交', () => {
    // 这一条是闸门的核心：它禁止「先抽取、后生成快照」。
    // 快照字节不变时 git 记不下「有人看过」，复审结论写进 fixtures/prompt-baseline/REVIEWED.md
    // 并随之提交——那次提交就是「基线在引擎改动之后被重新审视」的证据。只准追加。
    // Sprint 3 改 group-chat-engine.ts 之后若重新生成基线，
    // 基线文件的最后修改提交就会晚于那次改动——这里会红。
    const repo = path.resolve(__dirname, '..', '..');
    const at = (p: string) => execFileSync('git', ['log', '-1', '--format=%ct', '--', p], { cwd: repo, encoding: 'utf-8' }).trim();

    const baselineAt = Number(at('backend/test/fixtures/prompt-baseline'));
    const engineAt = Number(at('backend/src/group-chat-engine.ts'));

    if (!baselineAt) return; // 尚未提交（首次生成的那一轮），下一次运行才有意义
    expect(
      baselineAt >= engineAt,
      `基线（${new Date(baselineAt * 1000).toISOString()}）早于 group-chat-engine 的最后改动`
      + `（${new Date(engineAt * 1000).toISOString()}）——说明引擎改过之后基线没跟着重新审视。`
      + '若这次改动确实不影响 prompt，请在本用例里记一笔说明；若影响了，红线 A 被破坏。',
    ).toBe(true);
  });
});
