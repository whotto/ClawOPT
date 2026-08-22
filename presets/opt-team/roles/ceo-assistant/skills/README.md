# skills/ — CEO助理 的技能库

工作区技能是**优先级最高**的技能位置：同名时覆盖 project agent skills、personal agent skills、托管技能、内置技能与 `skills.load.extraDirs`。

> 本文件的技能表与目录树由 `_shared/gen-skills-readme.py` 生成，**内容与磁盘实际一致**。
> 路由表指向不存在的技能是最常见也最致命的配置问题——它不报错，只是静默失效。

## 已装备技能

| 技能 | 做什么 | 版本 | 篇幅 | 最小权限（allowed-tools） |
|------|--------|------|------|--------------------------|
| `content-digestion` | 搭档丢过来一篇文章、一个链接、一段转发、一份 PDF 时，5 分钟内消化成一张知识卡片并归档 | v1.0 | 186 行 | `web_fetch web_search Read Write Edit memory_search memory_get` |
| `deep-research` | 面向个人学习的好奇心放大器——搭档对某个课题、产品、领域感兴趣，想系统了解但不为直接做商业决策时用 | v1.0 | 201 行 | `web_search web_fetch Read Write Edit memory_search memory_get` |
| `human-writing` | 把任何要交给人读的中文稿子写成"一个见过事、查过材料的人在说话"，并按七遍顺序改掉 AI 腔 | v1.0 | 172 行 | `Read Write Grep Glob exec` |
| `idea-management` | 搭档随口抛出一个想法、灵感、念头时，把它接住、保留原话、轻量提炼、分类入池，随时可回顾 | v1.0 | 212 行 | `Read Write Edit Grep memory_search memory_get` |
| `oscar-research` | 把一个说不清、多维度的复杂问题做成系统调研——一个赛道能不能做、一个行业怎么样、竞品格局如何、一个项目靠… | v1.0 | 249 行 | `web_search web_fetch memory_search memory_get Read Grep Write` |
| `point-intel` | 挖单个明确的信息点——某个数据、某项指标、某个时间线、某家公司的某个事实 | v1.0 | 222 行 | `web_search web_fetch memory_search memory_get Read Write` |
| `skill-authoring` | 把一段反复用到的工作流，写成符合 House Spec 的新技能，或者改进、评测、淘汰已有技能 | v1.0 | 189 行 | `Read Write Grep Glob exec` |
| `task-execution` | 兜底执行技能——搭档说"帮我做点什么"但不属于想法、内容、调研任何一类时走这里 | v1.0 | 202 行 | `Read Write Edit Grep Glob web_search web_fetch memory_search memory_get` |

合计 **8** 条，全部通过 `_shared/validate-skills.sh` 的 House Spec 十项校验。

## 目录结构

```
skills/
├── content-digestion/
│   ├── SKILL.md
│   └── assets/knowledge-card.md
├── deep-research/
│   ├── SKILL.md
│   └── assets/research-report.md
├── human-writing/
│   ├── SKILL.md
│   ├── references/revision.md
│   └── scripts/check_prose.py
├── idea-management/
│   ├── SKILL.md
│   └── assets/idea-card.md
├── oscar-research/
│   ├── SKILL.md
│   ├── assets/oscar-report.md
│   └── references/README.md
├── point-intel/
│   ├── SKILL.md
│   └── assets/point-delivery.md
├── skill-authoring/
│   ├── SKILL.md
│   └── assets/skill-template.md
├── task-execution/
│   └── SKILL.md
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
