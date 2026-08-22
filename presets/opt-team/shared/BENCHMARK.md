# 技能体系竞品对标（2026-08-22 核实）

> 全部结论来自本人实际检索核实，不采用二手转述。来源见文末。

## 一、四家的真实强项（各取其长）

### 360（SkillHub + 360智能体卫士）— 强在**安全与治理**

| 能力 | 事实 |
|------|------|
| 三线安全审核 | Skill 上架前必过：内容合规过滤 + 科恩实验室深度漏洞扫描 + 云鼎实验室 AI 模型安全评估，任一不通即拒 |
| 四级信任机制 | 官方认证技能 / 第三方技能 / 自定义技能 / 未知来源技能，按签名来源动态分配沙箱权限 |
| 技能级权限管控 | 按需启用禁用单个 Skill；文件访问、系统执行、网络外传分别管控 |
| 沙箱隔离 | Skill 在独立沙箱运行，与核心系统隔离 |
| 漏洞扫描 | 覆盖 82 个已知 AI Agent 漏洞 |
| 风险数据 | 360 报告：**近四成 Skill "带病上岗"**；Skill 已成智能体生态的主要风险入口 |
| skill-vetter 审核协议 | 来源检查 → 强制代码审查（14 条红旗）→ 权限范围评估 → 四级风险分类 → 审核报告 |

**它们提出的核心概念**："合法动作的非法后果"——正常身份、正常工具、正常流程下，因诱导或上下文污染执行出违背业务意图的结果。

### WorkMate（中央财经大学 × 兆企供应链，开源企业级 Agent 框架）— 强在**岗位级权限 + 审计追溯 + 量化效果**

| 能力 | 事实 |
|------|------|
| 权限粒度 | 控制粒度细化到**每一个岗位**的权限 |
| 真实验证 | 在兆企供应链内部运行近两年，覆盖报价识别、合同生成、客户画像、风控预警 |
| 量化效果 | 报价响应 20 分钟 → 30 秒；市场分析报告 4 小时 → 15 分钟；合同审批 1 天 → 20 分钟 |
| 落地洞察 | 中国人民大学吴武清：企业最担心的不是 AI"**不聪明**"，而是 AI"**做错事**"；Agent 部署成本中训练只占 18%，**72% 花在知识库建设与流程改造** |

### 智谱（GLM-5 / AutoClaw）— 强在**模型 agentic 能力 + 生态**

| 能力 | 事实 |
|------|------|
| 模型能力 | GLM-5（2026-02-11 发布）744B 总参/40B 激活，200K 上下文；BrowseComp 62.0（超过 Claude Opus 4.5 的 37.0）；τ²-Bench 89.7；MCP-Atlas 67.8 |
| 产品 | AutoClaw（2026-03-10 上线）本地一键部署，可接多模型；官方文档直接支持 OpenClaw + ClawHub 技能安装 |
| 模型故障转移 | `primary` + `fallbacks` 配置，主模型失败自动降级 |
| 生态 | 3000+ Skill 资源可 `npx clawhub install` |
| 它们的四拼图论断 | 模型（能力）+ MCP（手）+ **Skill（定义场景化 SOP）** + Memory（沉淀语境偏好） |

### 豆包 / 扣子 Coze — 强在**可视化编排 + 可调试 + 知识库工程**

| 能力 | 事实 |
|------|------|
| 工作流编排 | 图形化拖拽，节点串联；**子工作流 + 主工作流**复用（拆书视频案例上百节点） |
| 试运行调试 | 编辑后可【试运行】，右侧预览与调试区实时验证 |
| 知识库工程 | 分段切片（自动/自定义）、三种索引（全文/向量/**混合检索推荐**）、召回数量 3-5 条、最小相关度阈值、召回测试窗口 |
| 知识库 vs 记忆 | 明确区分：静态资料进知识库，用户行为进记忆 |
| 变量与数据库 | 变量存 Key 避免明文泄露；结构化参数先由 LLM 整理再调 API |
| 多渠道发布 | 一键发布到豆包、飞书、抖音、公众号 |

**它们的短板**：技能锁死在平台内，不可移植；无技能级权限声明；无标准化元数据。

---

## 二、开放规范基线（agentskills.io，Anthropic 发起并开源）

已被 Claude Code / ChatGPT & Codex / Cursor / GitHub Copilot / VS Code / Gemini CLI / OpenCode / Goose / **OpenClaw** 等 45+ 客户端采用。

**SKILL.md frontmatter 完整字段**：

| 字段 | 必需 | 约束 |
|------|------|------|
| `name` | 是 | 1-64 字符；仅小写字母数字和连字符；不得以连字符开头结尾；不得连续连字符；**必须与父目录同名** |
| `description` | 是 | 1-1024 字符；须说清**做什么 + 何时用**；含帮助路由的关键词 |
| `license` | 否 | 许可证名或引用打包的许可文件 |
| `compatibility` | 否 | ≤500 字符；环境要求（目标产品、系统依赖、是否需要联网） |
| `metadata` | 否 | 任意字符串键值对（author、version 等） |
| `allowed-tools` | 否 | 空格分隔的预授权工具列表（实验性），如 `Bash(git:*) Read` |

**目录约定**：`SKILL.md`（必需）+ `scripts/`（可执行代码）+ `references/`（按需读的文档）+ `assets/`（模板与静态资源）。

**渐进披露（Progressive Disclosure）三级**：

1. 元数据（约 100 tokens）：启动时只加载所有技能的 name + description
2. 指令（**建议 <5000 tokens**）：任务匹配时才加载 SKILL.md 全文
3. 资源：`scripts/`、`references/`、`assets/` 用到才读

**硬性建议**：`SKILL.md` **保持在 500 行以内**；明细下沉到 `references/`；文件引用保持一层深度，不做深层嵌套链。

---

## 三、本套技能的 10 条超越标准

每一条都对应上面某一家的强项，或补上四家共同的空白。

| # | 标准 | 对标谁 / 补谁的空白 |
|---|------|-------------------|
| 1 | **完整 frontmatter + 严格合规命名** | 对齐 agentskills.io 开放规范 → 45+ 客户端可移植。**Coze/豆包的技能锁死平台内，做不到** |
| 2 | **最小权限声明**（`allowed-tools` + 权限与数据边界段：读什么/写什么/发不发外部/敏感数据怎么办） | 借鉴 360 四级信任 + WorkMate 岗位级权限。**四家中只有 360 有技能级权限，且靠平台强制而非技能自带声明** |
| 3 | **执行留痕与可审计**（每个技能写清留什么痕、可回溯什么） | 借鉴 WorkMate 审计追溯。回应"企业最担心 AI 做错事" |
| 4 | **每步退出条件（Exit Criteria）** | Coze 工作流有流程控制，提示词型技能普遍没有。**这是"读了技能没执行技能"的唯一解药** |
| 5 | **输入输出契约 + 技能组合链** | 借鉴 Coze 子工作流复用。让技能之间能真正串起来，而不是各写各的 |
| 6 | **常见失败模式表（反面清单）** | **四家都没有系统性的 anti-pattern 库**。这是纯增量 |
| 7 | **量化验收指标** | 借鉴 WorkMate 的量化效果口径。不写"做得好/不及格"，写可数的门槛 |
| 8 | **自检闸门（Gate）** | 借鉴 Coze 试运行。交付前必须逐条过，不过就回退 |
| 9 | **记忆写回契约** | 借鉴智谱"Memory 沉淀语境偏好" + Coze"知识库 vs 记忆"的区分 |
| 10 | **降级与失败路径** | 借鉴智谱模型 fallback 思路，推广到流程层：搜不到怎么办、收敛不了怎么办、时间不够怎么办 |


---

## 四、生态全景与“我们补哪一层”（2026-08-22 更新）

### 两个源头

| 项目 | 出身 | 架构核心 | 已核实的短板 |
|------|------|---------|-------------|
| **OpenClaw** | Peter Steinberger（PSPDFKit 创始人）2026 初开源，MIT；后加入 OpenAI | **Gateway 驱动**（控制平面）：把 WhatsApp/Telegram/Slack/Discord/iMessage/飞书等接到 Agent | **官方 SECURITY.md 明确划出修复范围**（原文见下）；社区技能无强制审核；Node 环境部署门槛高 |
| **Hermes Agent** | Nous Research 2026-02，MIT | **Agent Loop 驱动**（自我进化闭环）：执行 → 反射 → 抽技能 → 改进 | 完整记忆依赖 ChromaDB；偏框架而非开箱即用；安装比 OpenClaw 繁琐 |

### OpenClaw 官方安全边界（`SECURITY.md` 原文，2026-08-22 核实）

> "OpenClaw is local-first agent infrastructure for **trusted operators**; it is not designed as a shared multi-tenant boundary between adversarial users on one gateway."
>
> "Anyone who can operate an agent can make it do anything that agent can do. Session ownership, visibility, and presence are **usability features, not security boundaries**."
>
> **What Usually Is Not a Security Bug** 明确列出：
> - "Prompt injection without a policy, auth, approval, sandbox, or tool-boundary bypass."
> - "A malicious plugin after a trusted operator installs or enables it."
> - "A trusted operator using an intentional local feature, such as local shell access or browser/script execution."

**读法**：这不是 OpenClaw 做得差，而是它把信任模型**明确划在了"操作者可信"这条线上**——线内它负责，线外它不认。于是"技能被投毒""网页里的指令被当成命令执行""凭据对模型完全可见"这三件事，**按设计就该由配置层自己补**。本套 `reference/SECURITY.md` 补的就是这一层。

### Hermes 自进化闭环（2026-08-22 核实的实现细节）

| 机制 | 实现 |
|------|------|
| 触发 | 完成 **≥5 次工具调用**的复杂任务后自动抽取可复用技能；撞到死胡同又找到通路时也写 |
| 周期自评 | 每约 **15 个任务**做一次自我评估，提取成功经验写成技能 |
| 存放 | `~/.hermes/skills/` 单一真相源；每个已装技能自动成为一个斜杠命令 |
| 审批门控 | `write_approval` **默认 false**（自由写）；设 true 则暂存到 `~/.hermes/pending/skills/` 待审 |
| 治理 | 技能被**定期打分与淘汰**（grade and prune），防止技能库膨胀成垃圾场 |
| 规模 | 内置 85 个技能 / 22 个类别 |
| 渐进披露 | Level 0 只看技能清单与描述（约 3000 tokens），Level 1 才加载全文 |
| 记忆 | 三层：会话记忆 / 持久记忆（事实与偏好）/ **技能记忆（学到的解决模式）**；SQLite + FTS5 + LLM 摘要；Honcho 辩证式用户建模 |
| 可移植 | 遵循 agentskills.io 标准，SKILL.md 可在其他兼容运行时加载 |
| 外挂优化 | `hermes-agent-self-evolution` 用 DSPy + GEPA 从执行轨迹优化技能文件，约 $2–10/次，无需 GPU |
| 实测收益 | 用户反馈：使用自生成技能后，同类研究任务提速约 40% |

**我们怎么用**：照搬闭环，但**把门控默认反过来**——本套默认 `write_approval = true`（新技能先进 `skills/_pending/` 待人工过目）。理由：Hermes 有 Tirith 预执行扫描和容器强化兜底，OpenClaw 没有；且 360 报告近四成 Skill 带病上岗。**没有沙箱就必须有审批。**

### 国际衍生与同类（用于确认我们的定位不重复造轮子）

| 项目 | 定位 | 我们借鉴什么 |
|------|------|-------------|
| ZeroClaw | 3.4MB Rust 单二进制，冷启动 <10ms，空闲内存 <5MB，SQLite+FTS5，无外部依赖 | **上下文极简主义**：启动文件 ≤20k 字符、技能 ≤500 行、明细下沉 `references/` |
| NemoClaw | 英伟达企业版，OpenShell 容器级沙箱 + 托管推理代理，**有审计链路** | **可审计**：每个技能写清留什么痕、可回溯什么 |
| NanoClaw / Goclaw / MimiClaw | 容器化 / Go 重写 / C 重写 | 不适用（运行时层） |
| Manus | 云端长任务，已被 Meta 约 20 亿美元收购；黑盒执行，**无持久身份** | 反例：本套的全部价值恰恰在**持久身份 + 可读文件** |
| Lindy / Gumloop | 可视化工作流，面向非技术用户 | 反例：GUI 换不来版本管理与可 diff 审计 |
| Perplexity Computer | 云沙箱 VM，400+ OAuth 连接器 | 提醒：连接器越多，凭据面越大 |

> **看榜单的纪律**：厂商软文榜（如 Vellum 把自己打 100 分排第一，Simular、Duet 同类）中，作者自家产品的排名直接忽略。本文件所有对标数据均为独立核实来源。

### 国产生态（渠道是国内落地的真变量）

| 厂商 | 产品 | 差异点 |
|------|------|--------|
| 腾讯 | WorkBuddy（云端+本地，企业办公）/ **QClaw**（微信扫码即用，首个微信官方认可的机器人，腾讯安全沙箱）/ 企业微信内置 ClawBot | 渠道最全 |
| 阿里 | **CoPaw**（Python 轻量，内存约为 OpenClaw Worker 的 1/5，内置 ReMe 记忆）/ HiClaw（Manager-Worker 多 Agent 编排） | 开源路线，灵活度高 |
| 字节 | ArkClaw（火山引擎 SaaS，两分钟部署，9.9 元起） | **飞书原生集成**是别家学不来的 |
| 百度 | 红手指 Operator（云端虚拟手机，Agent 装进安卓，58 元/月） | 移动端自动化 |
| 智谱 | AutoClaw（一键安装，29 元起，自带 GLM） | 见 §一 |
| 月之暗面 | KimiClaw（200 万字上下文，129 元/月） | 长文档 |
| 其他 | MiniMax MaxClaw / 猎豹 EasyClaw（个人终身免费）/ **七牛 Linclaw**（MIT 开源，原生支持 9 大国内 IM 渠道）/ 网易有道 LobsterAI / 小米 miclaw（米家联动，封测） | Linclaw 的渠道覆盖 + 开源最适合自建 |

### 共性风险：全行业的"操作者信任"模型

除 NemoClaw 外，主流方案基本都是**操作者信任**模型：**模型对你的工具和账号有完全访问权**。这一层没人替你补。

本套配置补它的三个动作，全部写在 `reference/SECURITY.md`：

1. **凭据隔离纪律** —— 凭据永不进工作区、永不进记忆文件、永不进检索查询串
2. **抗提示注入协议** —— 把"外部内容"与"指令"在语义上强制分层，网页/文档/消息里的祈使句一律降级为数据
3. **技能准入四级信任** —— 借 360 的分级，落成配置层可执行的准入清单与 `skills/_pending/` 审批闸门

---

## 五、诚实的边界

本套技能**不覆盖**以下四家具备而我们不具备的能力，因为它们属于平台层而非技能层：

- 沙箱隔离运行、漏洞扫描、云端安全鉴定（360 平台能力）→ 建议配合 `clawdefender` 或 360 沙箱云使用
- 可视化拖拽编排界面（Coze）→ 本套是文件式，靠 git 版本管理而非 GUI
- 托管的向量知识库与召回调参（Coze）→ OpenClaw 侧由 `memory_search` 的 embedding provider 承担
- 模型级 agentic 能力（GLM-5 等）→ 技能不改变模型能力，只约束流程

**技能能做的是把"不确定性执行"约束成"可审计的确定性流程"。这正是四家里三家都没做到位的一层。**

---

## 来源

- 360智能体卫士 `agentsafe.360.cn`；SkillHub `skillhub.cn`；360 AI 安全研究院报告（新华网 2026-05-25）；360 通过公安部三所"人工智能安全态势管理系统"增强级认证（2026-06-17）
- WorkMate 开源发布（财联社 `m.cls.cn/detail/2409222`；中国经营报 `cb.com.cn`）
- 智谱开放文档 OpenClaw 页 `docs.bigmodel.cn/cn/guide/develop/openclaw`；GLM-5 基准（YouWare 指南、人人都是产品经理 GLM-5 实测）
- 扣子 Coze 教程（火山引擎开发者社区、阿里云开发者社区、53AI）；Coze Studio 开源版插件文档 `github.com/coze-dev/coze-studio/wiki`
- Agent Skills 开放规范 `agentskills.io/specification`；客户端清单 `agentskills.io`
