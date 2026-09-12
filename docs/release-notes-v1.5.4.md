# v1.5.4 —— 升级链路终于有退路了

无新功能、无界面变化。只做一件事：**改写配置之前一定有一份快照，回滚时连配置一起回。**

## 一张空头支票

`deploy-release.sh` 在迁移失败时对用户说：

```
配置可能处于迁移到一半的状态，**不继续重启 gateway**。
手动处理后重跑本脚本；升级前快照见 ~/clawopt-backups/。
```

而**没有任何代码路径创建过那个目录**。`scripts/backup.sh` 写得是对的——`VACUUM INTO`
在线备份、打包工作区、`openclaw.json` 脱敏留档——但它的调用点是 0。`AGENTS.md` 与两份
release notes 里那句「建议配 cron 每日一次」，实现数同样是 0。

这和 `deploy-release.sh` 自己在重启段写过的那句是同一个形状：**「契约写着、代码不跑」**。
当时为 `reconcile-openclaw-runtime.mjs` 修过一次，备份这条漏下了。

赌注是 `openclaw.json`。`config-atomic-write.test.ts` 的文件头早就写明了它是什么：
用户主机上唯一一份 OpenClaw 配置，含 gateway 凭据、全部模型 apiKey、全部 Agent 定义，
而 ClawOPT 没有为它做过备份。

## 回滚只回滚了一半

`update.sh` 失败时会 `git reset --hard` 退回升级前的提交，这条设计得很细——连
「不回滚的话 systemd 的 `Restart=always` 会拿着坏产物每 10 秒崩一次」都想到了。

但它**只回滚代码**。升级链路里的迁移闸门已经跑过 `openclaw doctor --fix`，把
`openclaw.json` 从 `agents.list` 迁成了 `agents.entries`；`patch-config.js` 每次部署
还会改写 `exec-approvals.json`。于是「回滚成功」之后的真实状态是——

> **1.x 的代码，配 2.x 的配置。**

名册门面的策略是「跟随现状、不主动迁移」，所以回滚后的旧代码会老老实实去读 `entries`。
可能碰巧还能跑，也可能不能。这条路径此前没有任何测试覆盖过。

## 这一版做了什么

- **新增 `scripts/snapshot-openclaw-config.sh`**：快速复制 `openclaw.json` /
  `exec-approvals.json` / `auth-profiles.json`，目录权限 700（整份都是凭据），
  滚动只留最近 10 份，成功时把快照路径打到 stdout 供调用方捕获。

  它**不是** `backup.sh` 的替代。那个做的是完整备份（`VACUUM INTO` + 打包整个
  workspace，可能几个 G）。把它放在升级的关键路径上，等于把一次几十毫秒的保险
  变成几分钟的等待——慢到最后一定会有人加 `|| true` 绕过去。两者不重叠：
  `backup.sh` 仍是 cron／手动的完整备份工具。

- **新增 `scripts/restore-openclaw-config.sh`**：必须显式指定恢复哪一份（不猜）；
  覆盖前先把**当前这份**照下来（`superseded-*`）——恢复不是销毁，万一「回滚」
  本身才是错的决定，迁移到一半的现场还得找得回来；快照不完整就拒绝，
  且一个字节都不碰现有配置。

- **迁移闸门 fail closed**：`doctor --fix` 之前照快照，照不上就**不迁移**。
  没有退路的迁移不该开始。

- **`update.sh` 升级前照快照、回滚时一并恢复配置**。顺序是先恢复配置再重新部署，
  让重新部署跑在回滚后的配置上。

## 顺带修掉两处一直在说谎的诊断

1. **迁移失败时报的退出码恒为 0。** 原来写的是
   `if ! openclaw doctor; then echo "（退出码 $?）"`，而 `$?` 在 then 分支里是 `!`
   取反之后的结果。一条一直在说谎的错误信息，比没有错误信息更糟。改用
   `cmd || DOCTOR_EXIT=$?` 捕获真实退出码。

2. **改完之后输出变成了乱码。** `$DOCTOR_EXIT）` 后面紧跟的是**全角**右括号，
   bash 把它的 UTF-8 字节当成变量名的一部分吃掉了。原来的 `$?）` 没事，只是因为
   `?` 是单字符特殊参数、立即终止。这个仓库的 shell 字符串全是中文，
   `${VAR}` 的花括号在这里不是风格问题。

## 清理

`prompt-baseline.test.ts` 的成员夹具里还留着 `runtime_kind` 与 `external_profile_id`
两个字段，是 v1.3.0「给 Agent 选运行时」被 v1.5.0 撤回后的残骸：DB 里没有这两列、
`src/` 下零引用、`buildAgentPrompt` 也不读。留着的唯一效果，是让下一个做外部 Agent
接入的人以为已经有了脚手架。删掉后基线字节未变（快照比对为证）。

## 守卫

全部先在旧代码上跑红，再写实现。

- **`deploy-migration-gate.test.ts` +3**：假 `openclaw` 的 doctor 分支会**覆写配置**，
  于是「快照里存的是旧形状」就成了**行为**判据——证明快照发生在 doctor 之前，
  而不是去读脚本文本里两段的先后（本文件开头明确反对后者）。另有「doctor 失败时
  快照仍在」「无需迁移时不照快照」，以及一条钉住真实退出码的断言。

- **`config-snapshot-restore.test.ts` 新增 10 条**：往返一致、权限 700、同秒不覆盖、
  恢复前留存被覆盖的那份、快照残缺／不存在／不传参数时拒绝且不碰现有配置。

  如实记一笔：其中三条负向用例在实现出现之前是**假绿**——脚本不存在时 bash 本来
  就非 0 退出。它们要等实现落地后才真正生效，这一点在写的时候就发现并复核过。

用例数 199 → 212，测试文件 22 → 23。

## 升级方式

照常 `bash update.sh`。这一版之后，升级前会多一行「已保存升级前配置快照：…」。
