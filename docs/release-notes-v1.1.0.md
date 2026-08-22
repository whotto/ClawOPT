# ClawOPT v1.1.0

**这一版包含安全修复，建议尽快升级。**

## 安全修复

三处未鉴权的信息泄露，都已实测确认堵住：

- `GET /api/config` 曾以明文返回登录密码与网关 token。能访问端口的人直接读到登录密码，登录页形同虚设。现在只返回 `hasToken` / `hasPassword` / `hasLoginPassword` 布尔位。
- `GET /api/files/download` 曾按 base64 绝对路径返回任意文件，唯一检查是「必须是绝对路径」。实测可读 `~/.ssh/id_rsa`、`/etc/passwd`、`auth-profiles.json`。
- `/openclaw` 曾把整个 `~/.openclaw` 静态挂出，实测可拉到 `openclaw.json` 里的模型 API key 与各智能体的凭据文件。

后两处现在共用 `backend/src/served-paths.ts` 的白名单闸门：只有工作区与上传目录下的非凭据文件可被服务，路径先 realpath 再判归属，符号链接逃不出去。

`POST /api/config` 补上鉴权——它能改登录密码、能关闭登录、能改网关指向。未开启登录时不受影响。凭据字段留空视为「不修改」而非「清空」。

**升级后请注意**：设置页不再回显已保存的凭据，输入框留空即维持原值。

## 一键装配：Web 界面入口

此前只能 SSH 到主机手敲 `install-preset.mjs`，Web 界面没有任何入口。现在：

左侧「角色预设库」→ 勾角色 → 填参数 → 预演 → 装配。预演不写任何东西，会先告诉你每个角色要写多少字符提示词、多少文件、哪些技能。已存在的同名智能体默认跳过，覆盖需显式勾选。

## 一键复制：把智能体或团队发给别人

- **导出**：侧边栏点开某个智能体或团队 → 导出 → 勾选带什么 → 下载 `.clawpack`。单个智能体约 80KB，六角色整团约 440KB。
- **导入**：上传文件**或粘贴一个链接**（链接由分享者自己托管，本项目不存任何包）→ 预演 → 装进自己的实例。ID 与显示名撞车都可当场改。

包是 gzip 压缩的 JSON，装之前可以自己看：`gunzip -c x.clawpack | jq '.manifest'`。

三条硬规矩：凭据永不进包（并对残留做扫描告警）；`memory/` 每日记录与对话历史从不导出、`MEMORY.md` 默认关闭；导入只写文件不执行，`automations.sh` 不会被自动注册。预演会明说哪些技能声明了执行命令的权限、哪些会联网。

## 角色预设库内容更新

课程设计角色原本 10 个技能全部标着「待安装」——一个都没装，而 `AGENTS.md` 在四个场景点名调用它们，是整套预设唯一一处路由指向空。本版补齐：

新增 7 个技能（共 21 个）：`course-material-pack`、`socratic-training-design`、`deck-builder`、`human-writing`、`mermaid-visual`、`skill-authoring`、`deep-diligence`。全部通过 House Spec 十项校验。课程设计剩余 4 条外部技能降级为可选增强。

## 工程

- `npm run presets:check` / `presets:sync`：预设与角色配置包的同步与卡口。预设是参数化副本，此前靠手工拷贝，已经漂过。
- `npm run locales:check`（已并入 `npm run test`）：三语键集一致性门。漏一个语言不会报错、只会显示原始 key，所以需要机械校验。
- 预设名册改为扫目录得出，`manifest.json` 不再手写角色数与技能数。
- 坏掉的预设（如缺 `preset.json`）现在报在名册上并给出原因，不再静默消失——目录仍然占着那个 id。

## 许可

本项目以 MIT 发布。上游未公开许可证，MIT 的适用范围与授权链写在 `NOTICE`，再分发前请先读它。
