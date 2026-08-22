# EXTERNAL.md — 外部技能装机清单

> 本文件是**机器可读的**装机清单，供 `audit-routing.sh` 区分
> 「路由到尚未安装的外部技能」（可接受，待装）与「路由到根本不存在的技能」（配置错误，P0）。
>
> 装一个就在 `状态` 栏改成 `installed`，并按 `README.md` 的接线步骤更新 `AGENTS.md`。

| skill | 来源 | owner | 信任级别 | 状态 |
|-------|------|-------|---------|------|
| humanizer-zh | 内置/龙虾弹药库 | — | T2 | pending |
| ljg-plain | 内置（李继刚系列） | — | T1 | pending |
| ljg-card | 内置（李继刚系列） | — | T1 | pending |
| structured-context-compressor | 内置 | — | T2 | pending |
| dapianke | 360 SkillHub | rampagepeter | T3 | pending |
| training-course-designer | 360 SkillHub | brandon-zhanghaodong | T3 | pending |
| webinar-outline-pro | 360 SkillHub | harrylabsj | T3 | pending |
| adaptive-socratic-questioning | 360 SkillHub | perpetualhui | T3 | pending |
| the-4p-marketing-consultant | 360 SkillHub | jacobluxj | T3 | pending |
| ljg-roundtable | 内置（李继刚系列） | — | T1 | pending |

## 已明确排除（不要再引入）

| skill | 排除原因 |
|-------|---------|
| creator-course-outline | 偏创作者课程，不适配企业家/创业者场景 |
| instructional-design-cn | 偏传统教学设计，不适配体验式/实战型课程 |
| ljg-learn | 偏知识拆解，不是课程设计核心能力 |
| ljg-writes | 偏写作，不是课程设计核心能力 |
| ljg-invest | 投资分析框架与 AI 课程设计无关 |

## 装机前必读

`reference/SECURITY.md` §三：四级信任 + 14 条红旗 + 六步准入流程。
**T3 技能必须先问{{USER_TITLE}}才能装。**
