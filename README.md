<p align="center">
  <b>ClawOPT · ClawOPT</b><br/>
  <sub>一键复制一支 AI 团队</sub>
</p>

# ClawOPT

**OpenClaw 的全功能 Web 客户端 + 可一键装配的角色预设库。**

市面上的 OpenClaw 客户端都在解决"怎么管 Agent"。
它们把建 Agent 做到了极致，但**建出来的 Agent 是空的**——默认的 `USER.md` 只有四行。

ClawOPT多做一件事：**把"装什么进去"也一起解决了。**

---

## 它是什么

| 层 | 能力 |
|---|---|
| **管理层** | 多智能体 UI 化配置、每个 Agent 独立模型与故障转移链、完全隔离的工作区、团队模式协同、移动端原生级体验、文档在线预览 |
| **内容层** | 内置角色预设库。一条命令把一整支配置好的 AI 团队装进去——带人格、方法论、退出条件、安全边界、技能库 |

---

## 快速开始

> [!IMPORTANT]
> 需要安装在**已原生安装 OpenClaw** 的 **Linux 主机**（非 Docker）上。

### 安装

```bash
# 推荐：先下载、看一眼、再执行
curl -fsSLO https://raw.githubusercontent.com/whotto/ClawOPT/main/install.sh
less install.sh
bash install.sh            # 默认端口 3115
bash install.sh 8080       # 自定义端口
```

<details>
<summary>为什么不直接给你一行 <code>curl | bash</code></summary>

因为本项目自己的安全规范里写着"第三方脚本必须先读一遍再执行"。
我们不会一边这么要求你的 Agent，一边让你对我们的脚本闭眼睛。

急的话这行也能用，风险你知情即可：

```bash
curl -fsSL https://raw.githubusercontent.com/whotto/ClawOPT/main/install.sh | bash
```

</details>

### 升级 / 卸载

```bash
curl -fsSLO https://raw.githubusercontent.com/whotto/ClawOPT/main/update.sh && bash update.sh
curl -fsSLO https://raw.githubusercontent.com/whotto/ClawOPT/main/uninstall.sh && bash uninstall.sh
```

### 装配一支团队

安装完打开 Web 界面 → 左侧 **角色预设库** → 勾角色 → 填三个参数 → **预演** 看清楚会写什么 → **装配**。
装完刷新侧边栏就能看到这几个 Agent，点进去直接说话。

预演不写任何东西，可以放心点。已存在的同名 Agent 默认跳过，要覆盖得显式勾选。

也可以在主机上走命令行（适合批量或写脚本）：

```bash
node scripts/install-preset.mjs              # 交互式
node scripts/install-preset.mjs --dry        # 只预演
node scripts/install-preset.mjs --yes        # 全默认，不问
```

> 装配分两条路：Agent 与 6 份 markdown 走 API，`MEMORY.md` / `skills/` / `reference/` / `automations.sh`
> 直接写工作区——因为 Gateway 的 API 目前不管后面这些，原因见 [`docs/preset-gap.md`](docs/preset-gap.md)。

### 文档预览增强（可选）

```bash
sudo apt update && sudo apt install libreoffice -y
```

---

## 核心能力

### 管理层

- **多智能体，全 UI 配置** —— 不用手改 JSON 和 Markdown
- **独立模型 & 故障转移** —— 默认主模型、全局故障转移、单 Agent 独立降级链；配合隔离工作区精准控制模型分流，减少背景重叠导致的 Token 浪费
- **完全隔离（Sandboxing）** —— 独立工作区、独立记忆，每个角色有专属 `SOUL.md` 与 `USER.md`，杜绝对话污染
- **团队模式** —— 多个 Agent 围绕同一任务分工协作，独立运行时工作区与消息链路
- **移动端优化** —— 响应式之上的沉浸式，接近原生 App
- **工业级预览** —— Word / PPT / Excel / PDF 在线预览，还原真实排版
- **原生指令直通** —— 对话窗口直接跑 `/status`、`/help`

### 内容层

- **角色预设库** —— 预设不是"人设一句话"，是完整工作区：`BOOTSTRAP` / `IDENTITY` / `SOUL` / `USER` / `AGENTS` / `MEMORY` / `skills/` / `reference/` / 定时任务
- **一键装配** —— 选角色 → 填三个参数 → 整支团队就位
- **可校验** —— 每套预设过三道闸门：注入预算、技能规格、路由对账

---

## 目录

```
├── backend/        Node + TypeScript 服务端
├── frontend/       React + Vite 前端
├── presets/        角色预设库（内容层）
├── scripts/        构建、版本、品牌工具
├── branding.json   品牌单一真相源
└── docs/
    └── _upstream-archive/   上游历史归档（按原样保留，不改名）
```

## 换品牌

品牌集中在 `branding.json`，改完跑一次脚本即可全项目生效：

```bash
vim branding.json
node scripts/apply-branding.mjs --dry   # 先预演
node scripts/apply-branding.mjs         # 执行
```

它会同步处理 npm 包名、systemd 服务名、数据目录、SQLite 文件名、localStorage 键、环境变量前缀和更新源 URL——**这些漏一个就会和其他版本在同一台机器上打架。**

