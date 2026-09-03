# v1.4.0 —— 外接 Agent 的凭据，可以在网页上配了

上一版（v1.3.2）的「运行时账号」页有两个问题。第二个更严重。

## 一、只用网页的人没法用它

那页给的是一条命令，要你去主机上敲。装 ClawOPT 就是为了不开终端，
所以对只用网页的用户，那页等于没有。

## 二、它接错了对象，在自信地显示错的状态

那页读 `openclaw models auth list` 判断 Claude Code 有没有登录。**那是错的库。**

引擎自己的文档（`docs/tools/acp-agents.md`）：

> Vendor auth must already exist on the host for that harness.
> `claude` — Requires Claude Code auth on the host.
> `gemini` — Requires Gemini CLI auth or API key setup.

外接 Agent 启动的是**厂商自己的 CLI 进程**，读自己的凭据库（`~/.claude` 等），
与 OpenClaw 的 `auth-profiles.json` 互不相干。`openclaw models auth login
--provider anthropic` 认证的是「OpenClaw 自己调 Anthropic API」的权限——
另一回事。

后果不是少个功能，是**说假话**：你按正确方式登录了 Claude Code，页面仍显示
未登录；反过来在 OpenClaw 里加个 Anthropic key，页面显示已登录，而
Claude Code 照样跑不起来。

## 现在的做法

页面上直接填 API Key。

引擎的故障排查表给了这条路：

> Vendor auth error from the harness → Log in or **provide the required
> provider key on the Gateway host environment**.

环境变量是官方支持的路径，**不需要 TTY**。ACP harness 是 Gateway spawn 的
子进程，继承它的环境。填完保存，ClawOPT 写入 `~/.openclaw/.env`（权限 600）
并重启 Gateway，即刻生效。

| 运行时 | 环境变量 |
|---|---|
| Claude Code | `ANTHROPIC_API_KEY` |
| Gemini CLI | `GEMINI_API_KEY` |
| OpenCode | `OPENCODE_API_KEY` |
| Codex（走 ACP） | `OPENAI_API_KEY` |
| Pi | **无** —— 只能在主机上登录 |

Pi 那一行是如实标注。引擎认识的 40 个凭据环境变量里没有它的
（`docs/cli/migrate.md`），编一个 `PI_API_KEY` 会让界面假装这条路通着。

### 为什么写 `.env` 而不是 `openclaw.json`

两处引擎都读。选 `.env` 是因为 ClawOPT 会把 `openclaw.json` 解析成对象、
并在多个接口里回显它的片段——本仓库**已经修过一次**
「`gateway.auth.password` 从 HTTP 500 里漏出去」。把明文密钥放进那个对象
等于重造同一类事故，而这次漏的是你的厂商 API Key。

（也查过 `openclaw secrets store`，走不通：文档明写
`Sandbox, remote node, ACP, and Codex-native shell execution do not receive them`。）

### 状态少了一个，是有意的

现在只有「已配置」和「未在此处配置」，**没有「未登录」**。

我们能确知的只有「我们写的那个变量在不在」。你有没有在主机上用厂商 CLI
自己登录过，要去猜 `~/.claude/` 之类的路径才能判断，各家格式和位置都会变，
猜错的表现就是上一版那样——已经登录了却显示未登录。

一个不敢乱说的界面，比一个自信说错的界面有用。

### Key 只进不出

没有任何接口能把它读回来，与 openclaw 自己 `secrets store get` 拒绝返回
secret 是同一个判断。忘了填的是什么就重填一次。

## 验证

- `npm test`：**206 passed**（v1.3.2 为 193）
- 红证 3 条：换行不校验 → 注入出第二个变量；整份重写 → 吃掉用户自己的行；
  不区分 unreadable → 塌成「没配」
- fs 调用点棘轮拦下新增读点，审阅后收进基线（57 → 58）
- 三语键集一致；`npm run build` 退出码 0

## 还没解决的

订阅制登录（Claude Pro/Max、ChatGPT Plus）走的是各家 CLI 自己的 OAuth，
不认 API Key，仍需在主机上登录一次。要在网页上做，得把设备码流程的
输出流式推到浏览器——可行，但不在这一版。
