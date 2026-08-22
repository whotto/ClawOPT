# EXTERNAL.md — 外部技能装机清单

> 本文件是**机器可读的**装机清单，供 `audit-routing.sh` 区分
> 「路由到尚未安装的外部技能」（可接受，待装）与「路由到根本不存在的技能」（配置错误，P0）。
>
> 装一个就在 `状态` 栏改成 `installed`，并按 `README.md` 的接线步骤更新 `AGENTS.md`。

| skill | 来源 | owner | 信任级别 | 状态 |
|-------|------|-------|---------|------|
| dapianke | 360 SkillHub | rampagepeter | T3 | pending |
| webinar-outline-pro | 360 SkillHub | harrylabsj | T3 | pending |
| the-4p-marketing-consultant | 360 SkillHub | jacobluxj | T3 | pending |
| ljg-roundtable | 内置（李继刚系列） | — | T1 | pending |

## 已由本地技能替代（不要再装）

原清单里的这几条已经有本地实现，全部通过 House Spec 十项校验，信任级别 T1，不需要走第三方准入流程。

| 原外部技能 | 本地替代 | 替代说明 |
|-----------|---------|---------|
| training-course-designer | `course-material-pack` | 讲师手册 / 学员练习册 / 案例库 / 评估表，四件物料带退出条件与量化验收 |
| adaptive-socratic-questioning | `socratic-training-design` | 三角色追问链 + 三档烈度 + 冷场预案，比原技能多了烈度调节 |
| humanizer-zh | `human-writing` | 七遍改稿顺序 + `scripts/check_prose.py` 机检，禁用项可自动判定 |
| ljg-plain | `human-writing` | 白话改写并入同一条技能的第三遍（拆表演性中文） |
| ljg-card | `mermaid-visual` | Mermaid 出图，零 API 依赖，源码可改可复用 |
| ai-ppt-generator / pptx-generator | `deck-builder` | 单文件 Reveal.js HTML，离线可分发。**注意：出的是 HTML，不是可编辑 .pptx** |
| structured-context-compressor | — | 上下文压缩由运行时自身承担，不再单列技能 |

## 已明确排除（不要再引入）

| skill | 排除原因 |
|-------|---------|
| creator-course-outline | 偏创作者课程，不适配企业家/创业者场景 |
| instructional-design-cn | 偏传统教学设计，不适配体验式/实战型课程 |
| ljg-learn | 偏知识拆解，不是课程设计核心能力 |
| ljg-writes | 偏写作，不是课程设计核心能力 |
| ljg-invest | 投资分析框架与 AI 课程设计无关 |

## 仍需外部技能的场合

| 需求 | 为什么本地做不了 |
|------|----------------|
| 可编辑的 .pptx 源文件 | `deck-builder` 出 HTML，改后缀或导图片都不算交付 pptx |
| 销售转化型课程结构 | 本地技能只覆盖教学结构，不含转化设计 |
| 线上直播的转化引导 | 同上 |

## 装机前必读

`reference/SECURITY.md` §三：四级信任 + 14 条红旗 + 六步准入流程。
**T3 技能必须先问{{USER_TITLE}}才能装。**
