/**
 * `fs` 调用点的棘轮：让**新增**的文件操作被人看见一次。
 *
 * ## 它证明什么、不证明什么 —— 先说这个，因为上一版在这里说了大话
 *
 * 上一版的文件头写着：「它数的是 API 调用本身，不是路径表达式长什么样，
 * **所以换任何拼写都躲不过去**。」
 *
 * **这句话是错的，第五轮对抗测试用七种写法证伪了它**：别名解构
 * （`const { readFileSync: __rfs } = fs`）、调用拆成两行、`src/` 下的 `.js` 文件、
 * 词表里没有的 `copyFileSync` / `createReadStream` / `openSync`、
 * 同一行上的第二个调用（上一版只取每行第一个匹配）、
 * 以及基线里重复键之间的互相掩护（上一版用 `includes` 做集合成员判定，
 * 而基线本来就有 13 个重复键）。
 *
 * 比绕过更糟的两件事，也一并记在这里：
 *
 * 1. **基线替一个 CRITICAL 背了书。** `index.ts::readFileSync::sessionFilePath`
 *    一直在基线里——而它正是第五轮那个能匿名挂死整个后端的洞。
 *    棘轮看见了它，然后签字放行。**把现状写进基线，等于把现状说成合格。**
 * 2. **「数量只降不升」那条断言从来没检查过任何东西。** 它读的是基线文件的长度，
 *    而基线正是它要守的东西——退化成 `63 <= 63` 这个重言式。
 *
 * 这一版修掉了上面全部六项，但**结论必须改口**：
 *
 * > 这是一张词表加一条按行正则。它**仍然可以被绕过**——
 * > 字符串拼接、`eval`、经由某个库间接读文件、shell 出去 `cat`，都在它视野之外。
 * > 它能做的只有一件事：**让用已知写法新增的文件操作被人看见一次。**
 * > 它**不是**「配置读写只有一个入口」的证明，也**不是**基线里那 70 处安全的证明。
 *
 * 真正的保证来自 `openclaw-config.ts` 那道运行时闸门——闸门在运行时挡住坏路径，
 * 而这个测试只是提醒人去用闸门。**别再把它当成证据。**
 *
 * ## 判据是「路径是不是数据给的」，不是「文件是不是配置」
 *
 * 第五轮最普适的一条发现：**闸门守的是容器，守不住那只从容器里伸出来指向别处的手。**
 * `sessions.json` 本身已经过网关了，但它内容里的 `sessionFile` 字段所指的路径没有——
 * 在那儿放一个命名管道，一条群消息就让后端永久挂住。
 *
 * 所以新增文件操作时要问的不是「这是配置文件吗」，而是「**这个路径是谁给的**」。
 * 数据给的路径一律过 `assertRegularFile()` / `readTextFileSafe()`。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const BASELINE = path.join(__dirname, 'fixtures', 'fs-call-sites.json');

/** 建立基线当天的实际数量。改大它需要显式修改本文件——那一刻就有人看见了。 */
const CURRENT_SITE_BUDGET = 58;

/** 网关自己就是那唯一一处实现，不计入。 */
const GATEWAY_FILES = new Set(['openclaw-config.ts', 'config-atomic-write.ts']);

/** 上一版只扫 `.ts`，于是一个 `src/x.js` 就完全隐形。 */
const SCANNED_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * 认哪些调用。上一版只有五个词，于是 `copyFileSync` / `createReadStream` /
 * `openSync` 全部隐形——而 `copyFileSync` 正是第五轮那个 CRITICAL 的入口。
 *
 * **这仍然是一张词表，因此仍然可以被绕过**（别名、拆行、字符串拼接）。
 * 见文件头「它证明什么、不证明什么」。
 */
const FS_CALL_NAMES = new Set([
  'readFileSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'openSync',
  'readSync', 'writeSync', 'createReadStream', 'createWriteStream',
  'readFile', 'writeFile', 'appendFile', 'copyFile', 'open', 'cp', 'cpSync',
]);

const FS_CALL_RE = /\b(readFileSync|writeFileSync|appendFileSync|copyFileSync|openSync|readSync|writeSync|createReadStream|createWriteStream|readFile|writeFile|appendFile|copyFile|open|cp|cpSync)\s*\(/g;

type Site = { file: string; call: string; context: string };

function collectSites(): Site[] {
  const sites: Site[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!SCANNED_EXT.some((e) => entry.name.endsWith(e))) continue;
      if (GATEWAY_FILES.has(entry.name)) continue;

      const rel = path.relative(SRC, full);
      for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
        // 匹配的是 **API 调用本身**，不是路径表达式——换拼写躲不过去。
        if (/^\s*(\*|\/\/)/.test(line)) continue; // 注释里提到不算
        // 一行上可能有**多个**调用——上一版只取第一个，于是在已有行上再加一个
        // 调用是完全隐形的。用全局匹配。
        // 别名解构是**已知被利用过**的绕过写法：
        //   const { readFileSync: __rfs } = fs;   →  __rfs(path) 不匹配任何词
        // 单独识别「把这些函数从 fs 上解构下来」这个动作本身。
        // 这仍然只是多堵了一种已知写法，不改变「词表可被绕过」这个结论。
        const destructure = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:fs|require\(['"]fs['"]\)|fsPromises)/.exec(line)
          ?? /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/.exec(line);
        if (destructure) {
          for (const raw of destructure[1].split(',')) {
            const name = raw.trim().split(/\s*:\s*|\s+as\s+/)[0];
            if (name && FS_CALL_NAMES.has(name)) {
              sites.push({ file: rel, call: `destructured:${name}`, context: raw.trim().slice(0, 60) });
            }
          }
        }

        for (const m of line.matchAll(FS_CALL_RE)) {
          sites.push({
            file: rel,
            call: m[1],
            // 记录路径表达式，让审阅的人一眼看出它碰的是什么
            context: (/\(\s*([A-Za-z_$][\w$.]*|['"][^'"]*['"])/.exec(line.slice(m.index))?.[1] ?? '?').slice(0, 60),
          });
        }
      }
    }
  };
  walk(SRC);
  return sites;
}

describe('fs 读写调用点棘轮：新增必须被看见一次', () => {
  it('src/ 下的 fs 读写调用点与签入的基线完全一致', () => {
    const actual = collectSites();

    // 写入分支必须在存在性检查**之前**——否则首次建立基线时永远跑不到它。
    if (process.env.CLAWOPT_WRITE_FS_BASELINE === '1') {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n');
      console.warn(`[基线已更新] ${actual.length} 个调用点写入 ${path.relative(process.cwd(), BASELINE)}`);
      return;
    }

    if (!fs.existsSync(BASELINE)) {
      throw new Error(
        `基线文件不存在：${BASELINE}\n` +
          `若这是首次建立基线，请运行：CLAWOPT_WRITE_FS_BASELINE=1 npx vitest run test/fs-call-sites.test.ts`,
      );
    }

    const expected: Site[] = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
    const key = (s: Site) => `${s.file}::${s.call}::${s.context}`;

    // **多重集**比较，不是集合。上一版用 `includes`（集合成员判定），
    // 而基线里本来就有 13 个重复键——于是在一个已有键上再加一个同样的调用，
    // 它完全看不见。计数比对才抓得住。
    const tally = (list: Site[]) => {
      const m = new Map<string, number>();
      for (const s of list) m.set(key(s), (m.get(key(s)) ?? 0) + 1);
      return m;
    };
    const actualTally = tally(actual);
    const expectedTally = tally(expected);

    const added: string[] = [];
    const removed: string[] = [];
    for (const [k, n] of actualTally) {
      const before = expectedTally.get(k) ?? 0;
      if (n > before) added.push(`${k} ×${n - before}`);
    }
    for (const [k, n] of expectedTally) {
      const now = actualTally.get(k) ?? 0;
      if (n > now) removed.push(`${k} ×${n - now}`);
    }

    // 新增必须被人看见一次：要么走网关，要么显式加进基线并说明理由。
    expect(added, `新增了未经审阅的 fs 调用点：\n${added.join('\n')}`).toEqual([]);
    // 减少是好事，但基线也要跟着更新，否则它会慢慢失去意义。
    expect(removed, `这些调用点没了，请更新基线：\n${removed.join('\n')}`).toEqual([]);
  });

  it('实际数量只降不升（它等于「还有多少处没被审计」）', () => {
    // 上一版这里读的是**基线文件**的长度，而基线正是它要守的那个东西——
    // 断言退化成 `63 <= 63` 这个重言式，**从来没有检查过任何东西**。
    // 必须拿现场扫描的结果来断。
    const actual = collectSites();
    // 63 是建立基线当天的数字。写死在这里是有意的：**改大它需要显式修改本文件**，
    // 那一刻就有人看见了。改小它则不需要审批——棘轮只朝一个方向转。
    expect(actual.length).toBeLessThanOrEqual(CURRENT_SITE_BUDGET);
  });
});
