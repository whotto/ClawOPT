# skills/ — 组织诊断 的技能库

工作区技能是**优先级最高**的技能位置：同名时覆盖 project agent skills、personal agent skills、托管技能、内置技能与 `skills.load.extraDirs`。

> 本文件的技能表与目录树由 `_shared/gen-skills-readme.py` 生成，**内容与磁盘实际一致**。
> 路由表指向不存在的技能是最常见也最致命的配置问题——它不报错，只是静默失效。

## 已装备技能

| 技能 | 做什么 | 版本 | 篇幅 | 最小权限（allowed-tools） |
|------|--------|------|------|--------------------------|
| `culture-audit` | 检查 Agent 在压力下有没有偏离既定原则——说话纪律破功、边界被越过、开始迎合用户、出现 AI 味、… | v1.0 | 199 行 | `Read Grep Glob Write memory_search memory_get` |
| `mermaid-visual` | 把已经想清楚的结构画成图——课程框架图、学习路径、决策树、流程图、组织关系、时间线、四象限、对比矩阵 | v1.0 | 179 行 | `Read Write Grep exec` |
| `oscar-research` | 把一个说不清、多维度的复杂问题做成系统调研——一个赛道能不能做、一个行业怎么样、竞品格局如何、一个项目靠… | v1.0 | 249 行 | `web_search web_fetch memory_search memory_get Read Grep Write` |
| `point-intel` | 挖单个明确的信息点——某个数据、某项指标、某个时间线、某家公司的某个事实 | v1.0 | 222 行 | `web_search web_fetch memory_search memory_get Read Write` |
| `progress-report` | 生成 AI 团队的进展报告——日报、周报或自定义时间段 | v1.0 | 178 行 | `Read Grep Glob Write memory_search memory_get` |
| `skill-assessment` | 盘点 AI 团队的技能配置——评估每个技能的成熟度、找出能力覆盖缺口与重叠、发现好技能并评估是否值得推广… | v1.0 | 179 行 | `Read Grep Glob Write memory_search memory_get` |
| `team-health-diagnosis` | 给搭档的 AI Agent 团队做健康诊断——五维扫描（配置完整度/技能完备度/使用活跃度/输出质量/协… | v1.0 | 243 行 | `Read Grep Glob Write memory_search memory_get` |

合计 **7** 条，全部通过 `_shared/validate-skills.sh` 的 House Spec 十项校验。

## 目录结构

```
skills/
├── culture-audit/
│   ├── SKILL.md
│   └── assets/culture-audit.md
├── mermaid-visual/
│   ├── SKILL.md
│   ├── assets/chart-patterns.md
│   └── scripts/mermaid-export.py
├── oscar-research/
│   ├── SKILL.md
│   ├── assets/oscar-report.md
│   └── references/README.md
├── point-intel/
│   ├── SKILL.md
│   └── assets/point-delivery.md
├── progress-report/
│   ├── SKILL.md
│   └── assets/progress-report.md
├── skill-assessment/
│   ├── SKILL.md
│   └── assets/skill-matrix.md
├── team-health-diagnosis/
│   ├── SKILL.md
│   └── assets/health-report.md
├── _pending/      待审批的候选技能（Agent 只能写这里）
├── _archived/     已淘汰技能的留档
└── _rejected/     评估后否决的技能与否决理由
```

## 编写规格

全部技能遵循 `_shared/SKILL-SPEC.md`（House Spec v1.0），十条硬标准：

1. frontmatter 六字段齐全（对齐 agentskills.io 开放规范，45+ 客户端可移植）
2. **最小权限声明** + 权限与数据边界段
3. 执行留痕与可审计
4. **每步可二值判定的退出条件**，并写死"未满足退出条件不得进入下一步"
5. 输入输出契约 + 技能组合链
6. 常见失败模式表
7. 量化验收指标（数字，不是形容词）
8. 自检闸门（不过就回退到第几步）
9. 记忆写回契约
10. 降级与失败路径

校验：

```bash
bash ../../_shared/validate-skills.sh     # House Spec 十项 + 命名 + 行数
skills-ref validate ./skills/<name>       # 官方参考实现校验 frontmatter
```

## 新增技能的唯一合法路径

**Agent 不得直接写入本目录。** 自己沉淀的候选技能一律先进 `_pending/`，经搭档批准后才移入。
完整机制见 `reference/EVOLUTION.md`。

> Hermes Agent 的 `write_approval` 默认 false（自由写），本套**默认 true**。
> 理由：Hermes 有容器强化与预执行扫描兜底，OpenClaw 没有；且 360 报告近四成 Skill 带病上岗。
> **没有沙箱就必须有审批**——否则一次被注入污染的会话就能写出持久化后门。

## 安装第三方技能

必须走 `reference/SECURITY.md` §三 的四级信任与六步准入流程。
见到这些**立即拒绝**：curl 到未知 URL · 索要凭据 · **访问 MEMORY.md/USER.md/SOUL.md/IDENTITY.md** · base64 解码 · eval 外部输入 · 索要 sudo。
