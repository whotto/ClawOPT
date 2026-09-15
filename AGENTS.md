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
  - `core/`: 与业务无关的底座，**不得依赖其他模块**。`db/`（控制面的表集中在 `control-plane-schema.ts`；原生插件构建隐患检测 `native-build-check.ts`）、`realtime/`（实时事件中枢与 `/ws` WebSocket 服务）、`auth/`（会话令牌、鉴权中间件与 `AUTH_PUBLIC_PATHS`、身份解析（HTTP 与 `/ws` 共用）、多用户 `user-store.ts`、登录 IP 锁 `login-lock.ts`、单一口令迁移 `login-migration.ts`、用户路由 `user-routes.ts`）、`files/`（可服务路径闸门、原子写、`SafeFileStore`）、`config/`（ClawOPT 自身配置）、`http/`（结构化错误与错误码、路由登记表与 OpenAPI、配置版本号）、`events/`（业务事件总线）、`logger/`、`paths/`、`process/`、`util/`。
  - `openclaw/`: gateway 客户端与连接、`openclaw.json` 读写与名册门面、版本探测、CLI 定位、网关探测与重启、运行时补丁、设备配对、网关单聊协议辅助（`gateway-chat-run.ts`、`chat-history-reconciliation.ts`），以及控制面的 CLI 统一调用口 `cli-runner.ts`。
  - `runtime/`: 执行平面的唯一入口（P1a 起）。`contract/`（`AgentRuntimeAdapter` 接口、能力声明、Responses 风格规范事件、事实来源仲裁表、文本去重）；`coordinator/`（运行协调器：会话行、run marker、陈旧事件、单会话单运行与队列、中止宽限、重放缓冲、工具调用原子落库、用量去重、终态顺序、审批/澄清注册表、工作区 diff 检查点缝、业务事件总线上的 `chat.run.*` / `chat.tool.*` / `chat.approval.*`）；`adapters/`（`openclaw` 网关单聊、`claude-code`）；`external-agents/`（CLI 命令构造、stream-json 解析、可注入的本机执行器）；运行时不变量。
  - `control/`: 控制面。agents（含克隆 `agent-clone.ts`、头像、引擎名册路由）/ characters / models（含生图、服务商编辑器 `provider-editor.ts`、连通性测试 `provider-probe.ts`、目录缓存与可见性 `model-catalog.ts`、审计 `provider-audit.ts`）/ gateway（浏览器、最大权限、主机接管）/ packs / presets / settings / commands / update / diagnostics，以及 P5a 新增的 cron / channels / skills / mcp / plugins / usage / logs（含网关服务状态卡）/ workspace-files（工作区身份文件）/ write-gate（写入审批）；`shared/` 放控制面共用的错误出口 `control-http.ts` 与引擎名册 `engine-roster.ts`。
  - `workspace/`: 上传、文件下载与预览、链接改写、文档与音频工具链。
  - `collab/sessions/`: 单聊（会话、历史、消息、OpenClaw 运行的投影器 `openclaw-chat-projection.ts`、流出口 `chat-stream.ts`）；`collab/rooms/`: 群聊（群聊引擎、群工作区、群路由、对账、外部成员运行的投影器 `external-member-run.ts`、群聊帧唯一构造处 `room-frames.ts`）。
  - `automation/`: 自动化（P4a）。`workflow/`（规范化、编译器、判定、区域调度器、运行与证据仓储、引擎门面、状态广播、导入导出）、`schedules/`（cron 计划）、`hooks/`（入站钩子）、`webhooks/`（出站 Webhook outbox）、`kanban/`（原生看板）、`runner/`（Agent 名册、`WorkflowAgentRunner` 实现、假 Runner）、`ports.ts`（对执行平面的唯一依赖）、`shared/`（自有 schema、错误码、设置）。表与迁移住在模块里（`shared/schema.ts`），经 `DB.connection()` 共用连接。
  - `bootstrap/realtime.ts`: 把 `/ws` 装到 HTTP 服务上（与 HTTP 同一套身份解析、按用户的主题授权、接回快照、交互答复）。
  - 模块之间只经各自的 `index.ts`（barrel）互相导入；`*-routes.ts` 只由 bootstrap 注册，服务不得引用。由 `npm run boundaries:check` 机械校验。
- `frontend/`: Web UI，包含单聊、群聊、设置、模型管理、文件预览等功能。`frontend/src/` 下：
  - `app/`: 应用壳。`App.tsx`（BrowserRouter + 鉴权）、`routes.tsx` 路由表、`routeState.ts` URL ↔ 视图状态纯函数（带单测，改路径形状两边一起改）、`AppShell.tsx`（侧栏 + Outlet）、`auth.tsx`（登录守卫）、壳层轮询 hooks，以及 `sidebar/` 侧栏（设置导航由 `sidebarNav.ts` 数据驱动，条目带 工作台/团队/自动化/系统 zone）。
  - 路由：`/login`、`/chat/:sessionId`、`/groups/:groupId`（无 id 为团队列表）、`/settings/:tab`（gateway / general / models / presets / commands / about，以及 P5a 控制面 agents / skills / mcp / users / cron / channels / plugins / usage / logs）、`/automation/workflows[/:workflowId]`、`/automation/kanban`、`/automation/webhooks`。页签清单 `SETTINGS_TABS` 与侧栏 `SETTINGS_NAV_ITEMS` 由 `sidebarNav.test.ts` 互相校验：新增页签两边一起加。用 history 路由，依赖后端 `app.get('*')` 回退 index.html；旧 `#settings/...` 书签挂载前自动换成新路径。缺段按 localStorage 记忆补齐，地址栏优先。
  - `pages/`: 路由页面容器。`chat/`（单聊与群聊共用同一组件实例）、`settings/`（所有页签共用一个挂载实例；状态在 `hooks/`，页签在 `tabs/`，弹窗在 `modals/`，预设库在 `presets/`，模型页附加区在 `models/`）、`login/`；控制面页面按分区放 `team/`、`automation/`、`system/`，由 `SettingsPage` 挂载、各自管状态，共用 `control/useControlApi.ts`（读 JSON、错误本地化、当前用户）与 `components/control/ControlUi.tsx`（按钮、卡片、弹窗等与设置页同一套样式）。
  - `features/`: 页面内功能块。`chat/`（`hooks/` 状态与副作用、`components/` 展示层、`lib/` 纯函数、`message/` 消息气泡与过程块）、`files/`（文件预览，按格式分查看器）、`workflow/`（工作流画布 `@xyflow/react`、运行回放、定时 / 钩子 / 导入导出弹窗；`lib/graph.ts` 的保存校验是服务端编译器的镜像，reason 码一致）。
  - `pages/automation/`: 自动化区页面（工作流、看板、Webhook）。
  - `api/`: 唯一的 HTTP 出口，按资源分模块，只返回原始 Response；流式入口（单聊发送/重新生成/接回、群聊 EventSource）在 `stream.ts`，实时通道客户端（`/ws`，重连退避、重新订阅、旧 socket 丢弃）在 `ws.ts`；单聊逐帧读取统一经 `features/chat/lib/chatStream.ts`，SSE 与 WebSocket 给出同一串帧；控制面各资源在 `control.ts` 里按资源分组。组件里不要再直接写 `fetch`，也不要自己 `new WebSocket`。
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
- `cd backend && npm test`: 类型检查 + vitest（覆盖凭据与会话、包解析与路径闸门、可服务路径白名单、上游消息解包、聊天历史对账、外部 Agent 适配与执行、运行时不变量）。**新增守卫时必须先证明它会红**：把对应的防护改回有缺陷的写法，看该用例失败，再还原。没验过的门等于没有门。
- **手工自检不是守卫。** 在命令行里跑一遍确认「它是对的」只证明这一刻对；守卫是下一个人改坏时会响的东西。验完就把它固化成用例，否则那次验证随会话一起消失。
- 能进类型层的检查就不放到运行时，能进运行时守卫的就不放到 code review。**每退一步，可靠性掉一个数量级。**
- `npm run locales:check`: 校验 `zh-CN` / `zh-TW` / `en` 三份 locale 的键集完全一致，并拒绝同一对象里的重复键（`JSON.parse` 静默取后者，键集比对照样通过）；缺一个语言不会报错、只会显示原始 key，所以这道门是硬性的（已并入 `npm run test`）。
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
- 凭据只出不进：任何配置接口都不得把 `token` / `password` / `loginPassword` 的**值**回给前端，只报 `hasXxx` 布尔位；写入时空串一律视为「不修改」而不是「清空」。这条来自一次真实泄露——未鉴权的 `GET /api/config` 曾把登录密码明文吐出来。P5a 又堵了一处同型的：`GET /api/endpoints` 曾回传每个服务商的明文 `apiKey`，现在只报 `hasApiKey` + 版本号。MCP 配置编辑器里 `env` / `headers` 的值以占位符出、写回时换回原值；频道列表里凭据形状的键一律换成 `hasXxx`。
- **多用户与授权（P5a）**：角色 `super_admin` > `admin` > `member`。`requireAdminAuth` 是 admin 及以上（它自己完成鉴权，注册在全局闸门之前的路由也能靠它），`requireSuperAdmin` 管用户，`requireAgentAccess` 校验路径参数 `:agentId` 在授权内。**改状态的控制面路由一律挂管理员闸门**，由 `test/control-plane-auth.test.ts` 按登记表逐条校验并用 member 会话真打（新增路由忘挂闸门会红）。登录未开启时请求按「隐式 super_admin」处理，单用户部署行为不变。
- **数据面按用户 ↔ Agent 过滤**（判据只在 `core/auth/resource-access.ts`，HTTP 与 `/ws` 共用）：单聊会话看会话的 Agent；群看「至少一个 Agent 在授权里」，改群结构（改成员 / 重置 / 删群）要求群里**每个** Agent 都在授权里，建群 / 加成员要求引用的 Agent 都在授权里；按消息 id 的改删先找到所属会话 / 群再判，群消息删除按路径里的群收窄。`GET /api/sessions`（侧栏与 Agents 页）与 `GET /api/groups` 按用户过滤；取 / SSE 流 / 停 / 发 / 改删消息看不见的资源回 403 `auth.agentForbidden`。建 / 改 / 删单聊会话会装配或撤销 OpenClaw Agent，挂 `requireAdminAuth`。新增按会话 / 群 id 取数据的路由必须挂 `chatSessionParamGuard` / `guardRoom` 这一类守卫，`test/member-acl.test.ts` 的矩阵要跟着加一行。
- **没有默认账号与默认口令**：不再回落 123456。用户只经三条路出现：启动一次性任务把管理员设过的口令迁成 `admin`（默认口令只在「登录已开启」时迁出且必须先改口令，改之前其余接口一律 403）、通用设置首次开启登录时设口令、super_admin 在用户页新建。**最后一个启用中的 super_admin 不能降级、停用、删除**；改角色 / 停用 / 删除 / 重置口令会作废该用户全部会话。登录失败按来源 IP 计数锁定（5 次 / 15 分钟），只有 TCP 对端是本机回环时才信转发头。
- **控制面对引擎的一切操作经 `backend/src/openclaw/cli-runner.ts`**：参数数组（不拼 shell）、`--json` 解析、stderr 脱敏、错误映射为 `openclaw.*` messageCode、写操作进程内串行。设了 `CLAWOPT_OPENCLAW_PROFILE` 就给每次调用注入 `--profile <name>`——验收与测试用它把引擎状态隔离到 `~/.openclaw-<name>`，**不要拿真实 `~/.openclaw` 跑写操作**。注意 `--profile` 下默认工作区仍落在 `~/.openclaw/workspace-<name>`（真实目录下），验收要显式给工作区并在结束后清理。
- **配置编辑器一律带版本号**：服务商、上下文长度、MCP 服务器、定时任务、工作区身份文件都走「锁内读当前 → 比版本号 → 写」，不符回 412 `REVISION_CONFLICT` + 当前（已脱敏）视图，缺版本号同样拒绝；前端收到 412 提示「已在别处修改」并载入最新内容。锁外比完再写等于没比。
- **写入审批（write-gate）是 ClawOPT 自建的暂存层**：开关打开后，Agent 工作区里 MEMORY.md / USER.md / SOUL.md 与 `skills/` 下的外部改动被暂存并**还原成已批准基线**；批准要求审阅时的哈希未变、磁盘仍是基线（否则 409），识别空补丁，按解析后的工作区目录串行。机制边界（亚秒级窗口、分不清 Agent 与手改、服务停止期间不拦截）写在界面帮助文本里，改机制时同步改文案。
- 新增或挪动后端路由后运行 `cd backend && npx ts-node scripts/dump-route-order.ts` 重写 `test/fixtures/route-order.txt`，**逐行审阅 diff** 再提交；同方法同路径的重复路由由 `control-plane-auth` 用例拦下（`GET /api/gateway/status` 撞过一次）。
- 一切按路径出文件的接口都必须过 `backend/src/core/files/served-paths.ts` 的白名单闸门（统一入口是 `backend/src/core/files/assert-servable-path.ts` 的 `assertServablePath()`，新增出文件的路由复用它，不要各写各的判定）（先 realpath 再判归属，再判文件名），不得只检查「是不是绝对路径」。**闸门之后是第二道门：数据面授权**——`core/files` 的 `servedPathOwner(realPath)` 推出文件归属（`workspace-group-<群>` → 群、`workspace-<Agent>` → Agent、上传目录 → `files` 表登记的会话 / 群、其余无主），`ResourceAccess.canAccessServedFile` 按用户判（无主与未登记的上传只给 admin），`/uploads`、`/openclaw`、download、preview、preview-data、html-preview（按实际发出的文件 realpath 判，软链挡得住）都走这两道门，顺序不能反；上传在 multer 落盘前按 `canUploadTo` 判（目标会话 / 群看得见，不带上下文只给 admin），`GET /api/files` 按用户过滤。矩阵在 `test/files-acl.test.ts`。允许的根只有工作区与上传目录；`~/.openclaw` 根、`agents/**`、凭据与密钥类文件永远拒绝。**修这类洞时必须把同类入口一起过一遍**：上一轮只堵了 `download` 与 `/openclaw`，紧挨着的 `preview` / `preview-data` / `html-preview` 漏了三个月，实测可读 `~/.ssh/id_rsa` 与 `openclaw.json` 里的模型 apiKey。堵一个不堵其余等于没堵。
- 服务端按用户给的 URL 去拉东西时（导入包等），三道检查缺一不可：协议只允许 http/https、**主机名解析后的地址**不得落在内网段、**重定向后的最终地址**要再查一遍。只查字面量挡不住 `localtest.me` 这类解析到回环的域名，只查首个地址挡不住 302 跳内网。
- `.clawpack` 是智能体/团队的可移植包（gzip JSON，实现在 `backend/src/control/packs/agent-pack.ts`）。改这块时三道闸门一个都不能松：导入侧的路径白名单（`assertSafeRelPath`，防目录穿越）、远端拉取的内网地址拦截（防 SSRF）、以及「导入只写文件不执行」。包里永远不得出现凭据、`memory/` 每日记录与对话历史。
- 预设装配有两个入口且共用同一条链路：Web UI（`GET /api/presets` + `POST /api/presets/:id/install`，实现在 `backend/src/control/presets/preset-installer.ts`）和 CLI（`scripts/install-preset.mjs`）。改装配行为时两边都要跟着改，否则界面装出来的团队和命令行装出来的会不一致。
- `presets/opt-team/` 是角色配置包（`../openclaw-agents`）的**参数化副本**，唯一真值源在配置包一侧；改预设内容要改源再跑 `npm run presets:sync`，不要直接手改副本。副本里的 `{{USER_TITLE}}` / `{{USER_ROLE}}` / `{{USER_STRENGTH}}` / `{{USER_BLINDSPOT}}` / `{{AGENT_AVATAR}}` 由同步脚本按规则生成，手工拷贝会把占位符写死成具体值，装配器的参数填充随之失效。
- 新增预设占位符时，必须同时改三处：`scripts/sync-presets.mjs` 的 `PARAM_RULES`、`presets/opt-team/preset.json` 的 `params`、以及装配器的 `fillPlaceholders` 覆盖范围。
- 不要把对用户有意义的参数、阈值、开关、配置做成隐藏实现；应优先提供界面入口让用户配置。
- **所有运行时的运行都经运行协调器（`backend/src/runtime/coordinator`），适配器只翻译。** OpenClaw 网关单聊与群聊外部成员（Claude Code）已迁入；直连模型与生图这两类单聊本地操作仍走 `LocalChatOperationManager`，迁移留给 P1b。分工：适配器（`runtime/adapters/*`）只负责启动、把原生输出翻译成规范事件、提供中止等控制钩子；投影器（各表面自己的，如 `openclaw-chat-projection.ts`、`external-member-run.ts`）只负责自己那一行消息与前端帧的形状；会话行、run marker、陈旧事件丢弃、单会话单运行与排队、中止宽限、重放缓冲、工具调用原子落库、用量去重、终态顺序（先清状态再发终态、队列空才写结束标记）、审批/澄清注册表**只在协调器里实现一次**。适配器或投影器里出现这些逻辑就是越界。
- 新运行时接入必须同时交三样：能力声明（`defineCapabilities`，缺一项过不了类型检查）、事实来源仲裁表（`defineSourceOfTruth`：文本 / 工具 / 终态 / 用量 / 控制各信哪一路）、以及至少一条「同轮双路事件不重复」的用例（参照 `test/runtime-arbitration.test.ts`）。用量上报的 `callId` 必须是确定性的（运行时原生 id 为底），`session_usage` 的部分唯一索引靠它去重。执行器保持可注入：本机子进程与远程 relay 是同一个接口。
- **实时帧只从实时中枢发**（`core/realtime` 的 `RealtimeHub`）。单聊帧是 `session:<id>` 主题的 `chat.frame`，群聊帧是 `room:<id>` 主题的 `room.frame`（唯一构造处 `room-frames.ts`）；SSE 与 WebSocket 都只是中枢的订阅者。不要再对 SSE 客户端直接 `res.write` 群聊或运行帧——那样 WebSocket 通道就收不到。
- WebSocket 事件契约（`/ws`，协议注释在 `core/realtime/ws-server.ts`）：鉴权与 HTTP 同一个 httpOnly cookie、**同一套身份解析**（`auth.authenticateHeaders`，升级失败回 401，不收查询串令牌；心跳时重新解析，令牌吊销 / 用户停用 / 必须改口令即 4401 断开，授权被收回的已订阅主题退订并回 `realtime.topicRevoked`）、升级请求过 Host 白名单（与 HTTP 中间件共用 `bootstrap/host-check.ts`）；订阅 `session:` / `room:` / `agent:` 主题前**按连接的用户**逐个授权（判据在 `core/auth/resource-access.ts`，与 HTTP 数据面路由共用：admin 及以上全部；member 的 `session:` / `agent:` 要求 Agent 在授权里，`room:` 要求群里至少一个 Agent 在授权里），直发发起连接与 `interaction.respond` 同样按身份判；每个事件带 `id` 与 `topic`；主题无人订阅时事件直发发起连接（`agent:` 主题除外）；慢消费者按 4008 断开；`subscribe` 带 `resume` 时回协调器快照（活跃运行、重放缓冲、队列、待决交互的剩余时间、接回帧）。新增主题类型时 `bootstrap/realtime.ts` 的授权、`test/auth-coverage.test.ts` 的 `/ws` 用例与 `test/member-acl.test.ts` 的授权矩阵要一起改。前端单聊默认仍走 SSE，WebSocket 由「设置 → 通用 → 对话实时通道」按浏览器切换，真机验证通过后再改默认。
- 涉及 `~/.openclaw`、agent provisioning、reset/delete 路由、任意文件下载/预览的改动，必须先说明影响范围、风险点和验证方式，再实施修改。

## 自动化模块（P4a）
- **执行平面只经 `automation/ports.ts` 的 `WorkflowAgentRunner`**（`runAndWait` / `abort` / `discardSessions`）。实现是 `runner/coordinator-runner.ts`：每个工作流节点与看板派活都是**运行协调器里 `workflow` 表面的真实会话**（会话键 `workflow:<sessionId>`；OpenClaw 走网关单聊适配器、网关会话键 `agent:<id>:workflow:<sessionId>`、专用连接结束即断开；外部运行时走各自的契约适配器，剩余时限同时交给执行器做硬超时）。`workflow` 表面不建单聊会话、不进群，所以不出现在聊天列表里；转录接口按会话键读 `run_sessions` / `run_tool_calls` / `session_usage`，运行面板运行中订阅 `/ws` 的 `session:workflow:<sessionId>` 主题。审批无人值守：提交带 `autoApprove`，协调器在请求排到队首时自动答「允许一次」（请求里没有 once 时拒绝）——今天 openclaw 与 claude-code 两个适配器都不声明 `approvals`，这条对它们不触发。删运行时 `discardSessions` 清会话行与工具调用（用量保留）。不要在引擎或看板里直接调网关、执行器或协调器。
- **工作流实时**：主通道是 `/ws` 的 `workflow:<id>` 主题（`workflow.status` / `workflow.evidence`，主题级增量游标，订阅带 resume 回「当前状态 + 当前运行全部证据」快照，客户端按行 id 合并），授权 = admin 或工作流里**每个**节点的 Agent 都在授权里（外部运行时节点对 member 不可见）；`GET /api/workflows/:id/events` 的 SSE 是兜底，判据相同。前端 `features/workflow/lib/workflowStream.ts` 在 WS 订阅被拒或 5 秒没确认时退回 SSE。待办中心订阅 `approvals:workflows`（只提醒「变了」、不带内容），列表经 `GET /api/workflows/pending-approvals` 按用户过滤；订阅不到退回 5 秒轮询。
- **自动化授权**（判据在 `core/auth/resource-access.ts`，矩阵由 `test/automation-acl.test.ts` 守着）：建 / 改 / 删工作流、批量删、导入、改运行设置、删运行、定时与入站钩子的建改删与轮换密钥、出站 Webhook 整组（端点、投递、本机测试收件箱）、看板管理与建改任务 / 批量 / 链接挂 `requireAdminAuth`（403 `auth.forbidden`）；工作流的读、导出、运行、停止、重跑、审批、证据与转录、定时与钩子的读挂 `guardWorkflow`（`canAccessWorkflow`：每个节点 Agent 都授权，外部运行时节点对 member 不算授权，即便授权清单里写了 `ext:` id；403 `auth.agentForbidden`，member 访问不存在的工作流同样 403）；看板任务的详情、评论（member 署自己的用户名）与 complete / block / dispatch 按负责 Agent 判（`canAccessKanbanTask`，无负责人或外部运行时负责人对 member 不可见），其余动作管理员；工作流列表、节点 Agent 名册、看板任务列表与看板计数按用户过滤。**新增自动化写路由**要么挂管理员闸门，要么进用例里的 `MEMBER_RESOURCE_SCOPED` 清单并在矩阵里加行，否则登记表用例会红。
- 本机演示与 UI 验证用 `CLAWOPT_WORKFLOW_FAKE_RUNNER=1`（确定性假 Runner，按节点任务里的 `[fake:delay|fail|seq|output]` 指令出结果）；界面会明确标出演示模式。
- 终态：`completed` / `completed_with_failures`（有节点失败，但每个失败都被 failure / always 路由接住）/ `failed` / `canceled`。**终态不可逆在仓储层强制**（`run-store.ts` 的 `WHERE status NOT IN 终态`），不要在服务层绕开；唯一的重置入口是带乐观并发条件的 `resetForRerun`。
- 三张证据表共用运行行上的 `evidence_seq`，在同一事务里取号（`UPDATE … RETURNING`）。终态运行只允许追加非 completed 的收尾循环轮次。
- 准入顺序固定：互斥锁 → 已有活跃运行 409 → 编译 → **静态执行上界 ≤1000** → Agent / 技能 / 附件预检 → 写运行行（此刻才算受理，HTTP 回 202）。任何预检失败都不得留下运行行。
- 停止与致命错误**先落库再中止**（`scheduler.ts` 的 `triggerFatal`）；迟到的完成看到终态就丢弃。重启时活跃运行一律按失败收尾（fail closed），不续跑。
- 每次运行的节点并发上限在界面「运行设置」里配（默认 2）；主机总内存 < 3GiB 或 Linux MemAvailable < 768MiB 时强制为 1（判据在 `shared/settings.ts`，不用 `os.freemem()` 判可用量）。
- 出站 Webhook 是**数据库 outbox**（至少一次、按端点先进先出、退避加抖动），来源是业务事件总线（`core/events`，在 `bootstrap/context.ts` 实例化）。`chat.run.*`（started / completed / failed / aborted）、`chat.tool.*`、`chat.approval.*` **只由运行协调器发**（`publishBus`，覆盖单聊、群聊外部成员、工作流节点，负载里 `surface` / `runtime` 区分），不要在表面或适配器里再发一份；新增事件类型时 `webhook-events.ts` 的类型表与映射、三语文案一起改，`test/run-coordinator-business-events.test.ts` 守着发布点与装配。URL 地址策略统一在 `core/net`：协议白名单、**全部**解析记录查内网与保留段、投递时再查一遍并**钉住 IP**、不跟随重定向。`.clawpack` 远端拉取用同一份判据，不要再写第二份。
- 入站钩子 `POST /api/hooks/workflows/:hookId` 与本机测试收件箱 `POST /api/hooks/webhook-test/:token` 是**有意公开**的，登记在 `AUTH_PUBLIC_PATHS`（条目支持 `:param` 单段匹配，判据在 `isAuthPublicPath`）。钩子的安全性全在处理器：HMAC-SHA256(secret, `时间戳.原始请求体`)、±5 分钟窗、签名防重放；密钥只在创建 / 轮换时返回一次。`express.json` 只为 `/api/hooks/` 保留原始请求体。
- 导入预览令牌存数据库（TTL 5 分钟、一次性、摘要复核、id 重映射）；导出丢模型绑定与附件路径并扫凭据键。`.clawpack` 可附带工作流（只建定义、不运行），三道闸门不变。
- 定时用 `croner` 的标准 cron 语义（Vixie OR、名字、IANA 时区、夏令时各触发一次）；触发占位表去重、错过即跳过（>60s）、重叠即跳过；只在 cron / 时区 / 启用变更时重算下一次。

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
