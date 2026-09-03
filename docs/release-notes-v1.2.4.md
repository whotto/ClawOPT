# v1.2.4 —— 为 OpenClaw 2026.8 做好准备

这一版让**同一份代码同时正确工作于 OpenClaw 2026.7.x 与 2026.8.x**。
没有新功能。如果你不打算升级 OpenClaw，升不升这一版都不影响现有行为。

**如果你打算升级 OpenClaw 到 2026.8：请先升到这一版，再升引擎。**
顺序反了的话，ClawOPT 新建的 Agent 引擎会看不见。

## 为什么需要它

OpenClaw 2026.8 把配置里的 Agent 名册从 `agents.list[]`（数组）
改成了 `agents.entries{}`（以 id 为键的对象），会话存储从 JSON 迁进了 SQLite。

在此之前的 ClawOPT 只认数组那一种。升级引擎之后：

- `openclaw doctor` 会把你已有的 Agent 迁到 `entries`，它们照常工作
- 但 ClawOPT **新建**的 Agent 仍会写进 `agents.list`——**引擎看不见它**，
  要手动跑一次 doctor 并重启才会出现
- 「系统提示词报告」那两个字符数会静默变空

## 这一版做了什么

### 名册读写统一走一层门面，策略是「跟随现状」

| 你的配置里有什么 | ClawOPT 写到哪 |
|---|---|
| 有 `entries` | entries |
| 只有 `list` | list |
| 两者都有 | entries，**并在日志里说明**这是迁移到一半的状态 |
| 两者都没有 | 按探测到的引擎版本；探测不到时用 `list` |

**不主动迁移。** 把已有 Agent 从 `list` 搬到 `entries` 是 `openclaw doctor`
的职责——我们迁一半、或语义与上游不一致，你会得到一份两个工具都不认的配置。
门面只保证「写到引擎正在读的那个地方」。

**探测不到版本时选 `list`，是因为两个方向的代价不对称**：在 2.x 上写 `list`
只是多一个废弃键，跑一次 doctor 就迁移了；在 1.x 上写 `entries` 则
**引擎完全看不见那个 Agent，且没有恢复路径**。

### 引擎版本探测不再依赖 `openclaw --version`

实测发现：一台机器上这条命令成不成功，取决于谁的 PATH 在前。
系统 Node 版本低于 openclaw 要求时它直接退出码 1，而 ClawOPT 的 systemd 单元
把隔离 Node 放在 PATH 最前才跑得通。

改为读安装目录的 `package.json`：不起进程、不看 PATH、不受 Node 版本约束。
先解析 `command -v openclaw` 指向哪一份——因为 gateway 用的就是那一份。

### 升级时先跑 doctor 迁移，再重启 gateway

`deploy-release.sh` 现在会检查「引擎已是 2.x 而配置里还有废弃键」，
是的话先跑 `openclaw doctor --fix --non-interactive` 并**校验退出码**。
失败**阻断部署**，不是打一句 Warning——一次没跑成的迁移和一次跑成了的迁移，
在日志里长得一模一样。

显式传 `--non-interactive`：`doctor --fix` 在没有 TTY 时曾静默跳过 2.0 迁移，
而通过 ssh 或自动化调用正是这种情形。

### 「读不到」不再伪装成「没有数据」

2.x 上读不到系统提示词报告时，界面会显示「（引擎已升级，本指标暂不可读）」，
而不是留一片空白——空白与「这个 Agent 还没跑过」长得一模一样。

顺带把 `configReadFailed` 接上了：它此前挂在四个只读接口上但**没有任何界面读它**。
现在 `openclaw.json` 读不动时，那几个字符数旁边会说明「下面这些数字可能不准」。

## 升级注意

- **无需改配置，无迁移步骤。** 本版自己不迁移任何东西。
- 若你已经升过 OpenClaw 到 2026.8，装完这一版后跑一次
  `openclaw doctor --fix` 即可让两边对齐。
- 升级 OpenClaw 之前建议先备份：`bash scripts/backup.sh`。

## 已知限制

- **`codex/*` → `openai/*` 的模型 id 归一没有被真机验证过**：
  实现是有的（比较时归一，不改写任何文件），但开发与生产环境里都没有
  配置过 codex 系模型，这条路径只跑过单元测试。
- 本版新增了一道 prompt 基线闸门（`backend/test/fixtures/prompt-baseline/`），
  用于保证后续重构不改变发给 Agent 的提示词。它是**开发期的守卫**，
  与运行时行为无关。

## 验证

- `npm test`：**158 passed**（v1.2.3 为 122），连续两次全绿
- `npm run build`：退出码 0
- `npm run presets:check`：186 项一致
- 三语键集一致
- 新增的每一道守卫都有「先把防护改回缺陷写法、看它变红、再还原」的记录
