# AGENTS.md

## 项目概述
- ClawOPT 是 OpenClaw 的 Web 客户端 / 控制台。
- 运行前提是已安装 OpenClaw 的 Linux 主机；README 明确要求原生安装，而非 Docker。
- 仓库采用前后端分离结构：前端为 React + Vite，后端为 Express + TypeScript。
- 生产模式下由后端服务 `frontend/dist`，同时提供 `/api`、`/uploads`、`/openclaw` 等接口。
- 运行数据保存在 `$HOME/$CLAWOPT_DATA_DIR`；后端还会直接读写 `$HOME/.openclaw`。

## 仓库结构
- `backend/`: 后端服务、OpenClaw gateway 客户端、SQLite、agent/session/group/file 管理。按模块组织（P0 起），`backend/src/index.ts` 只负责启动：
  - `bootstrap/`: 组装与生命周期。`context.ts` 构造单例与服务（经 `ctx` 注入）；`app.ts` 按固定顺序注册中间件与路由（顺序即行为，由 `test/route-order.test.ts` 对照清单校验）；`server.ts` 监听、就绪状态、优雅停机；`startup-steps.ts` 拆分前就有的启动修复；`startup-tasks.ts` 启动一次性任务登记表；`health.ts` 的 `/livez` `/readyz` `/health`。
  - `core/`: 与业务无关的底座，**不得依赖其他模块**。`db/`、`realtime/`（实时事件中枢与 `/ws` WebSocket 服务）、`auth/`（会话令牌、鉴权中间件与 `AUTH_PUBLIC_PATHS`）、`files/`（可服务路径闸门、原子写、`SafeFileStore`）、`config/`（ClawOPT 自身配置）、`http/`（结构化错误与错误码、路由登记表与 OpenAPI、配置版本号）、`events/`（业务事件总线）、`logger/`、`paths/`、`process/`、`util/`。
  - `openclaw/`: gateway 客户端与连接、`openclaw.json` 读写与名册门面、版本探测、CLI 定位、网关探测与重启、运行时补丁、设备配对。
  - `runtime/`: 执行平面的唯一入口（P1a 起）。`contract/`（`AgentRuntimeAdapter` 接口、能力声明、Responses 风格规范事件、事实来源仲裁表、文本去重）；`coordinator/`（运行协调器：会话行、run marker、陈旧事件、单会话单运行与队列、中止宽限、重放缓冲、工具调用原子落库、用量去重、终态顺序、审批/澄清注册表、工作区 diff 检查点缝）；`adapters/`（`openclaw` 网关单聊；编码类外部运行时各一个目录，共用件在 `_shared/`：可注入的进程执行器、子进程环境、续话判定、规范事件合成；`registry.ts` 是唯一的编码类运行时清单，见「外部运行时适配器」）；运行时不变量。P2 平台：`proxy/`（本地模型代理，Anthropic ↔ Chat ↔ Responses 互转与 tee）、`mcp/`（托管 MCP 注入、每运行健康隔离、各运行时原生 MCP 配置塑形纯函数、TOML / YAML 子集）、`manager/`（运行时描述符的唯一一份、PATH 发现、子进程环境白名单的唯一一份、输出脱敏规则的唯一一份、安装升级卸载与升级锁、主机能力、原生配置页后端、运行时目录与回收）、`remote-openclaw/`（远程 OpenClaw 网关成员）、`adapter-registry.ts`（`registerAdapter(descriptor, factory)`，七个编码类运行时与远程 OpenClaw 都登记在这里）、`platform.ts` / `platform-routes.ts`（组装与 `/api/runtime/*`）、`net-policy.ts`（出站地址策略；P4a 的 `core/net` 合入时二者取一份）、`platform-store.ts`（运行时平面的私有文件与本机加密）。
  - `control/`: 控制面。agents / characters / models（含生图）/ gateway（浏览器、最大权限、主机接管）/ packs / presets / settings / commands / update / diagnostics 的路由与服务。
  - `workspace/`: 上传、文件下载与预览、链接改写、文档与音频工具链。
  - `collab/sessions/`: 单聊（会话、历史、消息、OpenClaw 运行的投影器 `openclaw-chat-projection.ts`、流出口 `chat-stream.ts`）；`collab/rooms/`: 群聊（群聊引擎、群工作区、群路由、对账、外部成员运行的投影器 `external-member-run.ts`、群聊帧唯一构造处 `room-frames.ts`）。
  - `bootstrap/realtime.ts`: 把 `/ws` 装到 HTTP 服务上（主题授权、接回快照、交互答复）。
  - 模块之间只经各自的 `index.ts`（barrel）互相导入；`*-routes.ts` 只由 bootstrap 注册，服务不得引用。由 `npm run boundaries:check` 机械校验。
- `frontend/`: Web UI，包含单聊、群聊、设置、模型管理、文件预览等功能。`frontend/src/` 下：
  - `app/`: 应用壳。`App.tsx`（BrowserRouter + 鉴权）、`routes.tsx` 路由表、`routeState.ts` URL ↔ 视图状态纯函数（带单测，改路径形状两边一起改）、`AppShell.tsx`（侧栏 + Outlet）、`auth.tsx`（登录守卫）、壳层轮询 hooks，以及 `sidebar/` 侧栏（设置导航由 `sidebarNav.ts` 数据驱动，条目带 工作台/团队/自动化/系统 zone）。
  - 路由：`/login`、`/chat/:sessionId`、`/groups/:groupId`（无 id 为团队列表）、`/settings/:tab`（gateway / general / models / presets / commands / about / runtimes）。`/settings/runtimes` 是团队区的 Agent 运行时管理页，每运行时配置页用查询串 `?runtime=<id>&section=settings|mcp|skills`（不改路径形状，页面在 `pages/team/runtimes/`）。用 history 路由，依赖后端 `app.get('*')` 回退 index.html；旧 `#settings/...` 书签挂载前自动换成新路径。缺段按 localStorage 记忆补齐，地址栏优先。
  - `pages/`: 路由页面容器。`chat/`（单聊与群聊共用同一组件实例）、`settings/`（所有页签共用一个挂载实例；状态在 `hooks/`，页签在 `tabs/`，弹窗在 `modals/`，预设库在 `presets/`）、`login/`。
  - `features/`: 页面内功能块。`chat/`（`hooks/` 状态与副作用、`components/` 展示层、`lib/` 纯函数、`message/` 消息气泡与过程块）、`files/`（文件预览，按格式分查看器）。
  - `api/`: 唯一的 HTTP 出口，按资源分模块，只返回原始 Response；流式入口（单聊发送/重新生成/接回、群聊 EventSource）在 `stream.ts`，实时通道客户端（`/ws`，重连退避、重新订阅、旧 socket 丢弃）在 `ws.ts`；单聊逐帧读取统一经 `features/chat/lib/chatStream.ts`，SSE 与 WebSocket 给出同一串帧。组件里不要再直接写 `fetch`，也不要自己 `new WebSocket`。
  - `components/`: 跨页面复用的小组件；`utils/`: 与页面无关的纯逻辑（`message-merge`、`history-window` 等）；`locales/`: 三语文案。
  - 单个组件文件不超过 800 行；确需超过的在文件头写一行原因（目前只有 `features/chat/message/MessageBubble.tsx`）。
- `docs/`: 项目截图和文档资源。
- `install.sh`, `deploy-release.sh`, `clawopt.service`: 安装与部署脚本。

## 启动 / build / test / lint 命令
- `npm run dev`: 同时启动前后端开发环境。
- `cd backend && npm run dev`: 启动后端开发服务。
- `cd frontend && npm run dev`: 启动前端开发服务。
- `npm run build`: 同时构建前后端。
- `npm run release`: 构建后启动 release 预览流程。
- `cd backend && npm test`: 类型检查 + vitest（覆盖凭据与会话、包解析与路径闸门、可服务路径白名单、上游消息解包、聊天历史对账、外部 Agent 适配与执行、运行时不变量；P2 起还有本地模型代理六个翻译方向、运行时管理器、MCP 塑形与隔离、原生配置页、远程 OpenClaw 成员）。**新增守卫时必须先证明它会红**：把对应的防护改回有缺陷的写法，看该用例失败，再还原。没验过的门等于没有门。
- **手工自检不是守卫。** 在命令行里跑一遍确认「它是对的」只证明这一刻对；守卫是下一个人改坏时会响的东西。验完就把它固化成用例，否则那次验证随会话一起消失。
- 能进类型层的检查就不放到运行时，能进运行时守卫的就不放到 code review。**每退一步，可靠性掉一个数量级。**
- `npm run locales:check`: 校验 `zh-CN` / `zh-TW` / `en` 三份 locale 的键集完全一致；缺一个语言不会报错、只会显示原始 key，所以这道门是硬性的（已并入 `npm run test`）。
- `npm run presets:check`: 比对 `presets/opt-team/` 与角色配置包源（默认 `../openclaw-agents`）；不一致退出码 1，发布前卡口。
- `npm run presets:sync`: 把角色配置包同步进预设，并按 `PARAM_RULES` 把具体值换回 `{{...}}` 占位符。
- `npm run boundaries:check`: 校验 `backend/src` 的模块边界（跨模块只经 barrel、`core` 不依赖业务模块、服务不引用路由文件、只有入口导入 `bootstrap`）；违规退出码 1。
- `npm run harness:check`: 仓库不变量总入口，依次跑 `locales:check`、`boundaries:check`、`presets:check`、`native:sqlite`；找不到角色配置包源目录时明确跳过 `presets:check` 并说明原因（可用 `CLAWOPT_PRESETS_SRC` 指定源目录），发布前的卡口仍是 `npm run presets:check` 本身。
- **better-sqlite3 在 Node 24 上 GC 时 abort**（`Assertion failed: (env) != nullptr`，栈里是 `Statement::~Statement → node::RemoveEnvironmentCleanupHook`）：不是业务代码的问题，是原生插件被**用 Node 24 后期头文件从源码编译**了（prebuild 下载失败时 `node-gyp rebuild` 兜底），头文件内联的 `ObjectWrap` 清理钩子在 GC 弱回调里找不到 Environment。修复命令：`cd backend && npm rebuild better-sqlite3`（prebuild-install 会优先取官方预编译包）；若它仍然走源码编译（该平台/版本没有预编译包），换 Node 20/22 跑。`npm run harness:check` 的 `native:sqlite` 与后端启动日志都会检出这种构建（判据在 `backend/src/core/db/native-build-check.ts`）。改用语句缓存**不能**绕开它（实测缓存版 0.8 秒内同样崩），别再往代码里找根因。
- `cd backend && npm run openapi:generate`: 从路由登记表重新生成 `backend/openapi.json`（`-- --check` 只比对）。新增或改动路由后要重新生成，`test/openapi.test.ts` 会校验签入的文档是否过期。
- `./deploy-release.sh [port]`: 安装依赖、构建并部署 user-level systemd 服务。
- `npm run test`: 运行仓库级最小自动检查；当前仅覆盖前后端 TypeScript 类型检查，不等于完整业务测试。
- `cd backend && npm run test`: 后端 TypeScript 类型检查。
- `cd frontend && npm run test`: 前端 TypeScript 类型检查。
- `lint`: Unknown。未找到 root / backend / frontend 的标准 lint 命令或 lint 配置。

## 工程约定
- 保持当前前后端边界：前端通过 `/api`、`/uploads`、`/openclaw` 与后端交互。
- 保持前端产物兼容后端静态托管，不要假设生产环境一定存在独立前端服务。
- 开发环境前端端口固定为 `3105`；启动、调试、文档和协作过程中都应保持一致，不要随意变更。
- 版本号唯一真值源必须是仓库根 `package.json` 的 `version`；前端、后端、构建产物元数据、发布脚本和 GitHub Release 只能从这里读取版本，`package-lock.json` 等派生文件不得作为人工维护的版本真值源。
- 修改升级链路、`deploy-release.sh`、`update.sh`、OpenClaw runtime 收敛脚本或升级状态机时，“升级成功”不得只以 build 完成为准；必须同时包含 OpenClaw runtime 收敛成功、device repair 收敛成功、browser runtime 验收成功，才允许进入 `complete` / `update_succeeded`。
- 上一条里的 browser runtime 验收有一个例外：当用户的 `openclaw.json` 把浏览器排除在外时（`plugins.allow` 白名单不含 `browser`，或 `browser.enabled` 不为 true），这一步标记为 `skipped` 而不是 `failed`，升级照常算完成。**一个用户主动没启用的可选能力，不该让整条升级流程报红。** 判据集中在 `readBrowserUnavailableReason()`，与 `reconcile-openclaw-runtime.mjs` 里的跳过判据保持一致——两处判据分家过一次，代价就是一屏红色的假失败。
- 聊天页中的 `loadHistory` 只用于切换单聊 / 群聊后的首屏初始化，职责是加载“当前上下文最新一页”；不要把它当作发送完成或 `regenerate` 完成后的通用刷新入口。
- 聊天历史分页统一使用基于自增消息 ID 的 cursor 协议：`beforeId + limit`；不要改成 `offset` 分页，也不要在单聊和群聊里各自维护不同协议。
- 发送完成或 `regenerate` 完成后，应继续在当前分页状态内通过 append / patch / ID 替换收敛消息，不要重新引入整页 reload；否则会清掉已加载的旧页。
- 群聊多 agent live 场景下，assistant 消息一旦已展开显示，不应因为后续其他 agent 开始发言而自动收起，造成“正文假性缩短”；涉及 `MessageBubble`、`ProcessStepBlock`、`isLatest` 或群聊消息渲染逻辑的修改时，必须显式检查这一点。
- 新增模块的风格和样式必须参考现有模块；颜色、字号、按钮尺寸、边框、间距、交互反馈等保持一致，不要单独做一套新视觉。
- 全局不要使用阴影；需要层级或分隔时，优先使用浅灰色边框。
- 不要保留死代码。发现无调用点的脚本要么接回调用链、要么删掉，不能留着让文档描述一段不跑的契约（`reconcile-openclaw-runtime.mjs` 曾以 692 行的规模无人调用，而 AGENTS.md 一直在描述它的判据）。
- API 鉴权是**默认全保护 + 白名单放行**（`app.use('/api', ...)`），不是逐路由手挂。手挂的名单必漏——审计时 108 个路由只挂了 15 个，数据面（建会话、发消息、删会话、建群、传文件）全部裸奔。新增路由默认受保护，要公开必须显式加进 `AUTH_PUBLIC_PATHS`。**注意注册顺序同样决定公开性**：注册在 `registerAuthGate` 之前的路由闸门跑不到（`bootstrap/app.ts`），公开面清单由 `test/auth-coverage.test.ts` 逐条匿名请求校验。
- 登录令牌是**服务端存储的随机会话令牌**（`backend/src/core/auth/auth-store.ts`），带 30 天过期、可吊销、改口令即全部作废；口令用 scrypt 加随机盐存储。不要再回到「令牌 = 口令的哈希」——那样的令牌泄露一次永久有效，且默认口令能被离线算出。
- Web 端鉴权走 **httpOnly cookie**，不进 localStorage（XSS 能偷）、不进查询串（会进访问日志与浏览器历史）。请求头 `X-ClawOPT-Auth-Token` 保留给 CLI。SSE 的 `EventSource` 设不了自定义头，这也是必须用 cookie 的原因。
- 凭据只出不进：任何配置接口都不得把 `token` / `password` / `loginPassword` 的**值**回给前端，只报 `hasXxx` 布尔位；写入时空串一律视为「不修改」而不是「清空」。这条来自一次真实泄露——未鉴权的 `GET /api/config` 曾把登录密码明文吐出来。
- 一切按路径出文件的接口都必须过 `backend/src/core/files/served-paths.ts` 的白名单闸门（统一入口是 `backend/src/core/files/assert-servable-path.ts` 的 `assertServablePath()`，新增出文件的路由复用它，不要各写各的判定）（先 realpath 再判归属，再判文件名），不得只检查「是不是绝对路径」。允许的根只有工作区与上传目录；`~/.openclaw` 根、`agents/**`、凭据与密钥类文件永远拒绝。**修这类洞时必须把同类入口一起过一遍**：上一轮只堵了 `download` 与 `/openclaw`，紧挨着的 `preview` / `preview-data` / `html-preview` 漏了三个月，实测可读 `~/.ssh/id_rsa` 与 `openclaw.json` 里的模型 apiKey。堵一个不堵其余等于没堵。
- 服务端按用户给的 URL 去拉东西时（导入包等），三道检查缺一不可：协议只允许 http/https、**主机名解析后的地址**不得落在内网段、**重定向后的最终地址**要再查一遍。只查字面量挡不住 `localtest.me` 这类解析到回环的域名，只查首个地址挡不住 302 跳内网。
- `.clawpack` 是智能体/团队的可移植包（gzip JSON，实现在 `backend/src/control/packs/agent-pack.ts`）。改这块时三道闸门一个都不能松：导入侧的路径白名单（`assertSafeRelPath`，防目录穿越）、远端拉取的内网地址拦截（防 SSRF）、以及「导入只写文件不执行」。包里永远不得出现凭据、`memory/` 每日记录与对话历史。
- 预设装配有两个入口且共用同一条链路：Web UI（`GET /api/presets` + `POST /api/presets/:id/install`，实现在 `backend/src/control/presets/preset-installer.ts`）和 CLI（`scripts/install-preset.mjs`）。改装配行为时两边都要跟着改，否则界面装出来的团队和命令行装出来的会不一致。
- `presets/opt-team/` 是角色配置包（`../openclaw-agents`）的**参数化副本**，唯一真值源在配置包一侧；改预设内容要改源再跑 `npm run presets:sync`，不要直接手改副本。副本里的 `{{USER_TITLE}}` / `{{USER_ROLE}}` / `{{USER_STRENGTH}}` / `{{USER_BLINDSPOT}}` / `{{AGENT_AVATAR}}` 由同步脚本按规则生成，手工拷贝会把占位符写死成具体值，装配器的参数填充随之失效。
- 新增预设占位符时，必须同时改三处：`scripts/sync-presets.mjs` 的 `PARAM_RULES`、`presets/opt-team/preset.json` 的 `params`、以及装配器的 `fillPlaceholders` 覆盖范围。
- 不要把对用户有意义的参数、阈值、开关、配置做成隐藏实现；应优先提供界面入口让用户配置。
- **所有运行时的运行都经运行协调器（`backend/src/runtime/coordinator`），适配器只翻译。** OpenClaw 网关单聊与群聊外部成员（Claude Code）已迁入；直连模型与生图这两类单聊本地操作仍走 `LocalChatOperationManager`，迁移留给 P1b。分工：适配器（`runtime/adapters/*`）只负责启动、把原生输出翻译成规范事件、提供中止等控制钩子；投影器（各表面自己的，如 `openclaw-chat-projection.ts`、`external-member-run.ts`）只负责自己那一行消息与前端帧的形状；会话行、run marker、陈旧事件丢弃、单会话单运行与排队、中止宽限、重放缓冲、工具调用原子落库、用量去重、终态顺序（先清状态再发终态、队列空才写结束标记）、审批/澄清注册表**只在协调器里实现一次**。适配器或投影器里出现这些逻辑就是越界。
- 新运行时接入必须同时交三样：能力声明（`defineCapabilities`，缺一项过不了类型检查）、事实来源仲裁表（`defineSourceOfTruth`：文本 / 工具 / 终态 / 用量 / 控制各信哪一路）、以及至少一条「同轮双路事件不重复」的用例（参照 `test/runtime-arbitration.test.ts`）。用量上报的 `callId` 必须是确定性的（运行时原生 id 为底），`session_usage` 的部分唯一索引靠它去重。执行器保持可注入：本机子进程与远程 relay 是同一个接口。两路都收文本（`text: ['proxy', 'native']`）时协调器按轮次与段比对（`coordinator/turn-text-arbiter.ts`），不按 item id——两路 id 永远对不上。
- **会话命令结果只走契约事件 `session.command`**（`SessionCommandResult`：compact 的前后 token / 摘要、status 的原生会话状态、usage 的 token / 成本 / 上下文占用、失败原因；运行中途的自动压缩也用它）。不要再借道 `plan.updated`（计划面板会当步骤显示），也不要把 JSON 塞进 `outputText`（正文里一段 JSON、界面没法本地化）。单聊落库是 `role=system` + `⌘ ` 前缀 JSON，读历史与 `final` 帧都换成 `runtimeCommand.*` 码 + 参数，前端 `mapStreamingContentPatch` / `resolveStructuredMessageContent` 按三语渲染（`backend/src/collab/sessions/chat-command-result.ts`）。
- **实时帧只从实时中枢发**（`core/realtime` 的 `RealtimeHub`）。单聊帧是 `session:<id>` 主题的 `chat.frame`，群聊帧是 `room:<id>` 主题的 `room.frame`（唯一构造处 `room-frames.ts`）；SSE 与 WebSocket 都只是中枢的订阅者。不要再对 SSE 客户端直接 `res.write` 群聊或运行帧——那样 WebSocket 通道就收不到。
- WebSocket 事件契约（`/ws`，协议注释在 `core/realtime/ws-server.ts`）：鉴权与 HTTP 同一个 httpOnly cookie（升级失败回 401，不收查询串令牌，心跳时复查，失效 4401 断开）、升级请求过 Host 白名单（与 HTTP 中间件共用 `bootstrap/host-check.ts`）；订阅 `session:` / `room:` / `agent:` 主题前逐个授权；每个事件带 `id` 与 `topic`；主题无人订阅时事件直发发起连接（`agent:` 主题除外）；慢消费者按 4008 断开；`subscribe` 带 `resume` 时回协调器快照（活跃运行、重放缓冲、队列、待决交互的剩余时间、接回帧）。新增主题类型时 `bootstrap/realtime.ts` 的授权与 `test/auth-coverage.test.ts` 的 `/ws` 用例要一起改。前端单聊默认仍走 SSE，WebSocket 由「设置 → 通用 → 对话实时通道」按浏览器切换，真机验证通过后再改默认。
- **外部运行时的适配器从登记处取**（`runtime/adapter-registry.ts`）：适配器在自己的文件夹里 `registerAdapter(descriptor, factory)`，工厂拿 `RuntimeAdapterDeps`（管理器、代理、MCP 注入、运行时目录、可注入执行器、日志、scoped 服务商解析、用户 MCP 读取）；群聊引擎按 `member.runtime` 取，**没登记的运行时明说失败（`runtime.unknown: <id>`），不静默退回 OpenClaw**。同一个 id 重复登记直接抛。适配器依赖的是平台的真实现（`runtime/proxy`、`runtime/mcp`、`runtime/manager` 与 `manager.homes`），不要再造类型桩或过渡实现。
- **本地模型代理**（`runtime/proxy`）：`/api/runtime-proxy/{anthropic,responses}/:key/v1/*` 是**有意公开**的（外部 CLI 带不了登录 cookie），模式逐字登记在 `AUTH_PUBLIC_PATHS`，`:key` 只匹配恰好一个非空段（`isAuthPublicPath`）；安全性在处理器里：未知 key 404、每目标令牌（x-api-key 或 Bearer）常数时间比较不符 401。上游 key 永远不进 CLI 配置、不进日志、不明文落盘——重启恢复文件是 AES-256-GCM 密文，AAD 绑定目标全部坐标与令牌，本机密钥在数据目录 0600。上游地址只收 http/https、**解析后**不落内网（服务商显式标成本地——ollama / lmstudio / llamacpp / vllm / localai / `local:` 前缀——才放行）、不跟重定向。代理请求体解析器（64 MB）必须注册在全局 `express.json()` 之前。翻译夹具在 `backend/test/fixtures/runtime-proxy/`，是按线协议手写的，不是抓包。
- **子进程环境只从白名单起步**（`runtime/manager/path-env.ts` 的 `CHILD_ENV_ALLOWLIST`），`RuntimeManager.childEnv(extra)` 只把 PATH 换成扩充版再叠 `extra`。参考实现把整个进程环境并进启动环境、白名单形同虚设，这是我们要修的那个泄露；包管理器变量（`npm_config_*` 等）只给安装器，不给 Agent。扩充 PATH 时**原 PATH 在最前**：管理器报告的可执行文件必须就是实际会跑的那一个（本机实测两份 claude 版本不同）。
- **运行时安装升级不碰系统**：npm 全局安装装 `@latest`（不钉版本，官方源的运行时加 `--registry`）；pip 运行时（hermes-agent）装进 `<数据目录>/runtime/venvs/<id>`，**永远不用系统 pip**；不是 npm 全局、也不是我们 venv 里的安装（Homebrew cask 等）只探测不代管，升级卸载一律 409 `runtime.notManagedByClawopt`。升级锁、准备计数（`beginRun`）、活动版本号、连续空闲 60 秒、上锁前同步复查只在 `runtime/manager/runtime-manager.ts` 里实现一次。测安装卸载只能用隔离的 `npm_config_prefix`。
- **原生配置页凭据不出服务端**：读出时按键名与值形状把凭据换成 `<clawopt:redacted:N>`，保存时按序号从磁盘当前内容换回，标记对不上 400；认证文件（`auth.json`、`.credentials.json`、`.env`）只报在不在，不读不写；MCP 列表不回 env / headers 的值。改原生 MCP 配置用 `runtime/mcp/config-shapes.ts` 的纯函数：保留用户内容，托管条目（`clawopt-` 前缀或 env `CLAWOPT_MANAGED_MCP=1`，TOML/YAML 另有成对注释标记块）剥掉重生成；读不懂的文件报错，**绝不覆盖**。每次运行前的 MCP 健康隔离只改运行副本，隔离步骤自身失败放行。
- **远程 OpenClaw 成员**（`runtime/remote-openclaw`）：`external_config` 只放网关地址、远程 Agent、受信任局域网开关；令牌走 `PUT /api/runtime/remote-openclaw/members/:groupId/:agentId/token`（只写，空串不修改）进加密存储，接口只回 `hasToken`；群成员 `external_config` 写入时剥掉凭据类键（`GET /api/groups` 会原样回给前端）。地址只收 ws/wss，内网要打开受信任局域网；失败一律带 `remoteOpenclaw.*` messageCode。
- **运行时目录随归属回收**：`<数据目录>/runtime/<runtime>/<hash>`，删会话、删群、移出成员时 `runtimePlatform.releaseOwner(...)`，成员换运行时回收旧运行时下的（`exceptRuntime`），定期清扫按（归属, 运行时）判孤儿并清超期空闲（界面可调）；七个编码类运行时的 home 一律经 `manager.homes.ensureHome` 发，`test/runtime/adapters/shared/runtime-homes-gc.test.ts` 逐个守着；只删带 `.clawopt-home.json` 标记、realpath 在 root 下的真实子目录。新增会删会话或成员的入口时，要一起调 `releaseOwner`。
- 涉及 `~/.openclaw`、agent provisioning、reset/delete 路由、任意文件下载/预览的改动，必须先说明影响范围、风险点和验证方式，再实施修改。

## 外部运行时适配器
编码类外部运行时（Claude Code / Codex / Pi / Grok / OpenCode / DeepSeek Harness / Hermes Agent）在 `backend/src/runtime/adapters/<运行时>/`，共用件在 `_shared/`，唯一清单是 `registry.ts`（成员运行时选择器、群聊派发、运行时管理器都从它取）。
- **适配器只翻译。** 一份 `RuntimeDefinition` = 描述符 + 能力 + 仲裁表 + `prepare`（产出要写的文件、参数、启动环境，**纯数据**，金样用例直接比）+ `createDriver`（原生输出 → 规范事件）。会话行、排队、陈旧、落库、用量去重、审批注册表都在协调器；写进驱动就是越界。
- **以 `close` 判完成，不是 `exit`。** `exit` 可能先于 stdout 排空，最后一行（API 错误、用量）会丢。驱动只在 `finish()`（close 之后）决定成败；中止是 SIGINT 整个进程组、1.5 秒后 SIGKILL、等 close 才确认已停。子进程只经注入的 `ProcessExecutor` 起（`_shared/process.ts`），驱动与测试都不直接 `spawn`。
- **子进程环境是白名单**（`_shared/env.ts`，名单本身只有 `manager/path-env.ts` 的 `CHILD_ENV_ALLOWLIST` 一份）：scoped 只有白名单 + 启动变量；global 额外放行运行时声明的凭据变量（按名字；`CLAWOPT_*` 任何模式都不放行——凭据模式 `_AUTH_TOKEN$` 之类会把它顺出去），仍然不是整份环境。`test/runtime/adapters/shared/child-env-guard.test.ts` 对七个运行时 × 两种模式逐一校验。管理器合并出来的环境会再过一遍名单——守卫用例对着「把整份环境合并进来」的假管理器证明会红。
- **key 不进任何配置文件。** 上游 key 只进本地代理的内存；CLI 拿到的是代理令牌，而令牌也只进进程环境，文件里只写引用（Codex `env_key`、Pi `$VAR`、OpenCode `{env:VAR}`、Grok `env_key`、DSH `apiKeyEnv`、Hermes `${VAR}`；Claude 的 settings.json 里不写 `ANTHROPIC_API_KEY`）。每个运行时都有一条「生成的文件里没有 key 与令牌」的用例。
- **prompt 走 stdin 或文件，从不进 argv**（ARG_MAX、`ps` 可见、OpenCode 还会给带空格的位置参数加字面引号）。
- **不重定向 HOME / XDG。** 运行时 home 由平台发：`manager.homes.ensureHome(运行时, request.owner)` → `<数据目录>/runtime/<运行时>/<sha256(归属)>`（单聊按会话、群聊按 (群, 成员) 稳定，带 `.clawopt-home.json` 标记，删归属与定期清扫时回收），只经各 CLI 自己的指针变量生效。global 模式**不做影子 home**：本机 Codex 是 ChatGPT OAuth，影子副本刷新令牌会让用户真实的登录失效（Grok 同理）。
- **续话**：会话句柄由表面持久化，「句柄 → 原生 id + 创建时的坐标」记在运行时 home 的 `.clawopt-session.json`；预生成的 id 确认后才 resume；scoped 下 provider / model / apiMode 变了就开新会话。
- 新增运行时：一个目录 + 登记表加一行 + 三语 `runtime.*` 错误码（如有新码）+ 至少 25 条用例（命令构造两种模式、金样、真实输出回放、仲裁经协调器、续话兼容、close/exit 顺序、中止、错误映射），并在报告里记下对真 CLI 的核对。描述符（包名、命令、原生文件表）写在 `manager/descriptors.ts`，定义里用 `builtinRuntimeDescriptor(id)` 引用，不另写一份。

| 运行时 | 协议 | 续话 | 审批 | 必须记住的坑 |
|---|---|---|---|---|
| Claude Code | `-p --output-format stream-json --verbose --include-partial-messages`，stdin 文本 | `--session-id <预生成>` → `--resume` | `--permission-prompts none`（从不绕过权限） | stream-json 不带 `--verbose` 直接退出；`--append-system-prompt-file` 不在 `--help` 里但存在；hook_response 的 stdout 不是正文 |
| Codex | `exec --json … -`，压缩走 `app-server` JSON-RPC | `exec resume … <threadId> -`（不收 `--cd`） | bypass | `error` 是临时的（退出码说了算）；丢掉 `exec_command` 回声；scoped 两路都收文本（`text: [proxy, native]`），由协调器按轮次与段比对去重，驱动里不折叠 |
| Pi | `--mode rpc`，一轮一进程 | 同一个 `--session-id` + `--session-dir` | **真审批**：confirm → once/deny，select/input/editor → 澄清 | 只认 `agent_settled`（重试时先来 `agent_end willRetry`）；严格 LF 分帧 |
| Grok | `--output-format streaming-json --prompt-file` | `--session-id` 只能新建；`--resume` 前必须确认本地会话目录存在 | `--always-approve` | `--resume <本地没有的 id>` 会进交互式设备码登录挂住；`--no-auto-update` 不在 `--help` 里 |
| OpenCode | `run --format json --auto --thinking`，prompt 走 stdin | `-s <观察到的 sessionID>` | `--auto` | 没配服务商会悄悄回落免费模型（scoped 用 `enabled_providers`）；配置经 `OPENCODE_CONFIG_CONTENT` |
| DSH | `--profile acp`（ACP） | `session/resume`，失败不偷偷新建 | `DSH_PERMISSION_MODE=danger-full-access` + 自动「允许一次」 | 模型取值是 JSON 数组字符串；全新 DSH_HOME 首次 `session/new` 会报 no adapter registered，隔一秒重试 |
| Hermes Agent | `hermes acp`（ACP） | `session/resume`，核对来历 id | **真审批**：五个 ACP 选项 → once/session/always/deny | resume 先重放历史；上游错误当正文吐（`HTTP 401: …`）；普通 custom 端点会忽略 `codex_responses`，scoped 用 `anthropic_messages` |

## 国际化要求
- 所有新增的用户可见功能，默认必须同时支持 `zh-CN`、`zh-TW`、`en`。
- 不要在组件中新增硬编码用户可见文案。
- 所有新增文案必须进入语言资源文件，不得只写单语版本。
- 新增功能涉及按钮、标题、提示、空状态、表单校验、错误提示、成功提示、弹窗文案、菜单项等时，必须同步补齐三语文案。
- 新增系统消息或接口错误时，优先使用结构化 `messageCode` / `errorCode`；前端负责本地化主句，诊断信息使用 `rawDetail` / `errorDetail` 独立展示。
- 若本轮任务新增功能但未补齐三语支持，任务不算完成；若确实无法完成，必须明确标记 `TODO` 并说明原因。
- 三语一致性由 `npm run locales:check` 机械校验（已并入 `npm run test`）。它只比键集，不判译文质量——把中文抄进 `en.json` 能过门，过不了评审。

## 禁止事项
- 不要假设该仓库支持 Docker 部署。
- 不要给新模块引入与现有系统不一致的 UI 风格。
- 不要全局使用阴影。
- 不要新增死代码、废弃分支或只留不用的参数。
- 不要新增没有界面入口的用户配置。
- 不要使用 `alert` 弹窗。
- 不要把带有机器路径硬编码的脚本当作通用工作流。
- 不要声称仓库已有 CI、lint 或自动化测试覆盖，除非仓库内实际存在证据。

## 完成标准
- 至少运行与改动范围对应的构建命令；跨前后端改动时优先运行 `npm run build`。
- 若改动影响聊天、群聊、文件预览/上传、agent 管理或 OpenClaw 集成，应在真实 OpenClaw Linux 主机上验证；无法验证时标记 `TODO`。
- 若改动影响 `MessageBubble`、`ProcessStepBlock`、`isLatest`、群聊 live 消息合并或群聊消息渲染展开/收起逻辑，必须做真实页面的多 agent 协作群 live 回归验证，并明确记录每条 assistant 消息是否出现 `long -> short` 回退。
- 若改动影响单聊后端收尾链路，例如 `onFinal`、`scheduleCompletionProbe`、`probeCompletion`、`finalizeRun`（P1a 起分别在 `backend/src/runtime/adapters/openclaw.ts` 的网关判定与 `collab/sessions/openclaw-chat-projection.ts` 的落库推帧里），必须逐项对账并验证 `JSONL` 原始终态、`chat.history`、`chat_messages`、`/api/history/:sessionId`、真实页面 `DOM` 五处一致，且页面最终不能停在半句位置。能在本机验的四处由 `backend/test/chat-run-fake-gateway.test.ts` 逐帧守着（迁移前录制的基线），改收尾链路时先跑它。
- 发布前必须显式校验以下四项一致：根 `package.json.version`、目标 `git tag`、GitHub Release、实际发布 commit；若其中任一项不一致，不得把该版本视为已完成发布。
- 仓库没有标准自动化保障时，用 `Unknown` 或 `TODO` 明确说明，不要猜测。
- 新增配置项时，用户应可在界面中查看和配置；若暂时做不到，标记 `TODO` 并说明原因。
- 只有在相关命令仍可执行、且剩余运行时风险已写明时，任务才算完成。

## 发布关键步骤
- 本仓库正式发布依赖两部分同时成功：`git tag` 推送成功，以及 GitHub Actions `Release Sync` 成功创建 GitHub Release；只有 tag 没有 Release，不算发布完成。
- 发布前先把根 `package.json.version` 改到目标版本；`package-lock.json` 作为派生文件同步更新，但版本真值源仍然只有根 `package.json`。
- 发布前必须新增对应的 release notes 文件，命名固定为 `docs/release-notes-vX.Y.Z.md`；内容可精简，但文件必须存在。GitHub Actions 会读取这个文件创建 Release，缺失时会导致 tag 已推送但 Release 失败。
- 生产机默认**不构建**：发布时 CI 会产出 `clawopt-dist-vX.Y.Z.tgz` 并挂到 Release，`deploy-release.sh` 只在检出的 tag 与产物匹配时使用它。可用内存低于 1200MB 时脚本直接拒绝本地构建（`CLAWOPT_ALLOW_LOCAL_BUILD=1` 可强制）——2GB 主机跑 vite 会进 swap 风暴，连 sshd 都可能失去响应。
- `update.sh` 默认部署**最新发布 tag**，不是 `origin/main`；开发机跟 main 要显式 `CLAWOPT_TARGET_REF=main`。部署失败会自动回滚到升级前的提交并用旧代码重新部署——不回滚的话，工作区已是新代码、dist 可能是半成品，而 `Restart=always` 会拿着坏产物每 10 秒崩一次。
- 数据备份走 `scripts/backup.sh`（SQLite 用 `VACUUM INTO` 在线备份、工作区打包、`openclaw.json` 脱敏后留档），建议 cron 每日一次保留 7 份。SQLite 已开 WAL。
- 发布前必须跑 `npm run presets:check`；预设与角色配置包不一致时不得发布——装出来的团队会和配置包分叉，而且不报错。
- 发布顺序固定为：更新版本号 -> 新增 `docs/release-notes-vX.Y.Z.md` -> 运行必要的 `npm run test` / `npm run build` -> 提交到 `main` -> 推送 `main` -> 执行 `npm run release:publish` 推送 tag。
- `npm run release:publish` 只负责创建并推送 tag；GitHub Release 由 `.github/workflows/release-sync.yml` 在 tag push 后自动创建，不要每次都重新寻找手工发布方法。
- 发布后必须显式核对四项一致：根 `package.json.version`、远端 `main` 对应 commit、远端 tag `vX.Y.Z^{}`、GitHub Release 页面；四项不一致时，不得宣称版本已发布完成。
- 若 tag 已推送但 GitHub Release 缺失，第一检查项就是对应的 `docs/release-notes-vX.Y.Z.md` 是否随 tag 所指 commit 一起存在；如果缺失，应补文件、提交、将 tag 重新指向新提交并重新推送，再等待 `Release Sync` 重跑成功。

## 已知残余风险
- 同一 `sessionId` 叠发多条请求时，旧 run 的 `cleanup` 曾可能影响新 run 的活动状态、SSE 附着或最终消息落库。P1a 起网关运行由协调器按会话单运行管理：新请求先中止旧运行并等它收尾，旧运行之后到的事件按 run marker 当陈旧事件丢弃，SSE 流按 run id 绑定——这条风险在网关路径上已有结构性防护（`test/run-coordinator.test.ts` 的陈旧事件用例、假网关用例的「上一轮还在跑时发新消息」）。直连模型与生图两类本地操作仍靠中断 epoch，残余风险留给 P1b。它仍不能与“单聊半句截断”混为同一根因，也不能按“长文本被短文本覆盖”处理。
- 本机开发机（Node 24）上若 `better-sqlite3` 是从源码编译的，后端会在 GC 时 abort；见上文「better-sqlite3 在 Node 24 上 GC 时 abort」。
