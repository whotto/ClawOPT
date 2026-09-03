# v1.5.1 —— 修三个只在真机上才看得见的故障

这三个都是跑起来才发现的，测试全绿的时候它们已经在生产上了。

## 一、整站聊天不可用（最严重）

生产实测：每一次 agent 调用都失败于

```
control ui requires device identity (use HTTPS or localhost secure context)
```

单聊、群聊都中招。**很可能从 2026.8.2 升级当天就坏了**——没人发过消息，
所以没人发现。

根因在 ClawOPT 自己：它连网关时把自己伪装成浏览器控制台。引擎放行本地后端的
判据是

```js
const isBackendClient = client.id === "gateway-client"
                     && client.mode === "backend";
if (!isBackendClient || !isLocal || params.hasBrowserOriginHeader) return false;
```

而 ClawOPT 报的是 `openclaw-control-ui` / `webchat`，还额外送了一个
`Origin: ws://127.0.0.1:18789`（scheme 都不合法）。**三条全踩。**
2026.7 不查这个，2026.8 查了。

改成 `gateway-client` / `backend`，并且不再送 Origin 头。

## 二、外接 Agent 一进团队就变回 DeepSeek

界面上叫「Claude Code」的成员，在团队里问它是谁：

```
发言人:      Claude Code
model_used:  deepseek/deepseek-v4-flash
内容:        DeepSeek V4 Flash（deepseek/deepseek-v4-flash，厂商 DeepSeek）
```

加入团队时 ClawOPT 会建一个按团队克隆的运行时 Agent。克隆代码**本来就写了**
`model: sourceModelConfig.modelOverride`，但那个值永远是 null，因为读它的地方是：

```ts
const entry = Array.isArray(config.agents?.list)   // ← 只认旧形状
  ? this.rosterEntryRef(config, this.rosterShapeOf(config), agentId)
  : null;
```

2026.8 起名册是 `agents.entries`，`config.agents.list` 恒为 undefined，
三元式直接取 null——**每个 Agent 的独立模型 ClawOPT 都读不出来**。

单聊时看不出来，因为那条路是引擎自己读 `openclaw.json`；只有 ClawOPT 需要把
模型**复制**给克隆体时才暴露。

讽刺的是同一份文件早就有条注释写着这个坑（「2.x 上 `config.agents.list` 是
undefined，旧写法会静默不做任何清理」）——知道了，却只堵了那一处。
这一版加了棘轮：**任何在调用点重新判断名册形状的写法都会让测试变红**，
而且它先剥注释再扫，免得解释这个坑的注释把自己染红。

## 三、新成员第一次被 @ 必定失败一次

```
❌ Claude Code 响应失败: Agent "group-ctx-probe--ctx-cc" no longer exists in configuration
```

`provision()` 返回只代表「配置写完了」，而网关是靠监听文件变化热重载的——
中间有个窗口。在窗口里派活就会拿到这个错。重试一下又好了，最难查的那类。

在源头等（`waitForGatewayToSeeAgent`，上限 8 秒），而不是在某一个调用点加重试：
新建运行时 Agent 的路径只有这一条，堵在这里，后面所有调用方都不必各自记得重试。
等不到不抛——出声然后照常派活，让真实失败自己说话。

## 顺带记录：团队上下文实测长这样

让成员把收到的提示词原样吐出来（生产实测）：

```
=== 系统强制规定（最高优先级，必须遵守）===
规则1: 【以上下文为准】…与"团队对话历史/最新任务"冲突，必须以下面提供的为准
规则2: 【可选转交】若需他人继续处理，可在回复末尾加 "@姓名"（可用: 情报调研, Claude Code）
=== 规定结束 ===
<群描述>
团队工作区:
- 根目录 / 上传目录 / 输出目录
- 新生成的项目目录请创建在团队工作区根目录下，不要写入成员个人 workspace。
当前身份: CEO助理
<角色描述>
团队对话历史:
[用户]: …
[CEO助理]: …
最新任务 (用户):
…
```

- 团队历史是**纯文本注入**（`[发言人]: 内容`），不是结构化角色
- 每个成员有独立的 OpenClaw 会话，互相看不见；共享的只有这层群历史
- 窗口写死在源码：最近 15 条 × 每条末尾 380 字符，超出直接丢，无摘要无压缩
- 没 @ 时只有「上一个说话的 Agent」接话；Agent 之间可用 `@姓名` 自主转交，
  链深上限 6 轮，到顶后规则切换成【禁止@他人】

## 验证

- `npm test`：**189 passed**（v1.5.0 为 179）
- 红证 3 条：模型读取退回旧形状 → 3 红；握手报 control-ui → 1 红；重送 Origin → 1 红
- 三语键集一致；`npm run build` 退出码 0
