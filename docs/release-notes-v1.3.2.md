# v1.3.2 —— 运行时账号页，以及一处误导性显示

v1.3.0 让你能给 Agent 选 Claude Code / Gemini / Codex 这些运行时，
但**没有任何地方能让它登录**——那个功能只做了一半。这一版补上另一半。

## 加了「运行时账号」设置页

在系统设置里，逐个显示每个运行时的登录状态：

```
Claude Code   anthropic   ● 未登录
              openclaw models auth login --provider anthropic --device-code   [复制命令]

DeepSeek      deepseek    ● 已登录（deepseek:default）
```

**它不代你执行登录。** Gateway 的 WS 协议里有 `models.authStatus`、
`models.authLogout`，**没有 `authLogin`**——登录只有 CLI 一条路。
把按钮做成「点一下、背后 ssh 执行命令」会要求 ClawOPT 拿到主机 shell 权限，
攻击面比现在大得多，而且你看不见发生了什么。

命令统一带 `--device-code`：ClawOPT 装在远程主机上，默认的浏览器回调流程
在那儿走不通（没有浏览器、localhost 回调也到不了你的机器）。
设备码流程让你在**自己的浏览器**里授权，凭据由 provider 直接发给主机，
不经过 ClawOPT。

### 「未登录」和「问不出来」是两件事

状态有三态，不是两态。探测失败时显示的是**「状态未知」**而不是「未登录」——
把问不出来显示成没登录，你会去重新登录一个本来就好的账号，
而 `--force` 登录会**删掉现有 profile**。

## 修了一处误导性显示

侧边栏里每个 Agent 的副标题显示的是模型名。对一个跑在 Claude Code 上的
Agent，它会显示 `DeepSeek`——那是它名义上配的模型 ref，但**不是在跑它的东西**。

副标题回答的问题应该是「这个 Agent 由谁来跑」。现在 ACP 运行时的 Agent
显示运行时名，普通 Agent 仍显示模型。

**显示错的信息比不显示更糟**，所以这一处优先于登录页做。

## 验证

- `npm test`：**193 passed**（v1.3.1 为 189）
- 红证：探测失败塌成「未登录」→ 1 条红
- 三语键集一致；`npm run build` 退出码 0
