/**
 * 检索用的文本工具：分词（拉丁词 + 汉字二元组）、token 估算、关键词 → 种类规则（spec 06 §4.5 (c)）。
 */

const HAN = /\p{Script=Han}/u;

/** 查询词与索引词用同一套切法：拉丁 / 数字词（≥2 字符，小写），汉字连续段切成二元组（单字段保留单字）。 */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
    const run = match[0];
    if (HAN.test(run[0])) {
      if (run.length === 1) out.push(run);
      for (let index = 0; index + 1 < run.length; index += 1) out.push(run.slice(index, index + 2));
    } else if (run.length >= 2) {
      out.push(run);
    }
  }
  return out;
}

/** 写进 FTS 的形状：切好的词以空格连接，unicode61 分词器按空格切回来。 */
export function ftsText(text: string | null | undefined): string {
  return tokenize(text).join(' ');
}

/** FTS MATCH 表达式：每个词加引号、OR 连接；没有词返回 null。 */
export function ftsQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query))].slice(0, 32);
  if (!terms.length) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** token 估算：汉字按 1 个，其余按 4 个字符 1 个。 */
export function estimateTokens(text: string): number {
  let han = 0;
  let other = 0;
  for (const ch of text) {
    if (HAN.test(ch)) han += 1;
    else other += 1;
  }
  return han + Math.ceil(other / 4);
}

const KIND_RULES: Array<{ pattern: RegExp; kinds: string[] }> = [
  { pattern: /名字|叫什么|怎么称呼|称呼|\bname\b|\bcall me\b|\bwho am i\b/i, kinds: ['profile_name', 'interaction_contract'] },
  { pattern: /住在|住哪|家在|哪个城市|城市|老家|\bwhere (do )?i live\b|\bhome\b|\bcity\b|\blocation\b/i, kinds: ['home_location'] },
  { pattern: /工作|职业|做什么的|上班|\bjob\b|\boccupation\b|\bwork\b|\bprofession\b/i, kinds: ['occupation', 'project_context'] },
  { pattern: /时区|几点|\btime ?zone\b|\btimezone\b|\bwhat time\b/i, kinds: ['timezone'] },
  { pattern: /喜欢|偏好|爱好|习惯用|\bprefer|\blike\b|\bfavou?rite\b|\bpreference/i, kinds: ['general_preference', 'tool_preference', 'workflow_preference', 'communication_preference'] },
  { pattern: /流程|工作方式|\bworkflow\b|\bprocess\b/i, kinds: ['workflow_preference', 'recipe'] },
  { pattern: /工具|编辑器|软件|\btool|\beditor\b|\bide\b/i, kinds: ['tool_preference'] },
  { pattern: /家人|朋友|同事|老婆|老公|妻子|丈夫|孩子|女儿|儿子|父母|\bfamily\b|\bfriend|\bcolleague|\bwife\b|\bhusband\b|\bkids?\b|\bpartner\b/i, kinds: ['relationship'] },
  { pattern: /习惯|每天|通常|\bhabit|\busually\b|\broutine\b/i, kinds: ['habit'] },
  { pattern: /电脑|系统|环境|机器|\bos\b|\bmachine\b|\benvironment\b|\bsetup\b|\blaptop\b/i, kinds: ['environment_fact'] },
  { pattern: /项目|仓库|\bproject|\brepo\b/i, kinds: ['project_context', 'active_task'] },
  { pattern: /目标|计划|打算|\bgoals?\b|\bplans?\b/i, kinds: ['long_term_goal'] },
  { pattern: /决定|定下|\bdecid|\bdecision/i, kinds: ['durable_decision'] },
  { pattern: /吃|食物|过敏|饮食|忌口|\bfood\b|\beat\b|\ballerg|\bdiet\b/i, kinds: ['food_avoidance'] },
  { pattern: /任务|待办|\btasks?\b|\btodo\b/i, kinds: ['active_task'] },
];

export function kindsForQuery(query: string | undefined): Set<string> {
  const kinds = new Set<string>();
  if (!query) return kinds;
  for (const rule of KIND_RULES) if (rule.pattern.test(query)) for (const kind of rule.kinds) kinds.add(kind);
  return kinds;
}
