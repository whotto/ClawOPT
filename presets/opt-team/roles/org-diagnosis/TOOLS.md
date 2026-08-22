# TOOLS.md —— 已退役（内容已迁入 AGENTS.md 的 `## Tools` 段）

> 当前版本的 OpenClaw 已经取消 `TOOLS.md` 模板：本地工具与环境说明统一放在
> `AGENTS.md` 的 `## Tools` 小节，技能（skills）继续定义工具**怎么用**。
>
> 本文件保留只为兼容旧工作区与人工检索。**唯一权威副本在 `AGENTS.md` 的 `## Tools` 段**，
> 请不要在这里维护第二份，否则两边会漂移。

## 迁移

```bash
openclaw doctor --fix   # 归档本文件、把自定义内容并入 AGENTS.md、删除退役文件
```

## 为什么要分开放

技能是共享的，你的环境是你自己的。分开放意味着：更新技能不会覆盖你的笔记，分享技能不会泄露你的基础设施。

## 内容位置

- Skill 映射表 → `AGENTS.md` › `## Tools` › `### Skill 映射表`
- 方法论锚点 → `AGENTS.md` › `## Tools` › `### 方法论锚点`
- 搜索纪律 → `AGENTS.md` › `## Tools` › `### 搜索纪律`
- 本机环境笔记（摄像头名、SSH 主机、TTS 音色、设备昵称）→ `AGENTS.md` › `## Tools` › `### Local notes`
- 经验沉淀 → `AGENTS.md` › `## Tools` › `### 经验沉淀`


---

## 附录：OpenClaw 原版 `TOOLS.md` 模板（退役前的官方样例）

保留在此，因为它把"技能是共享的、你的环境是你自己的"这件事说得最清楚。
实际内容请写在 `AGENTS.md` 的 `## Tools` › `### Local notes` 段。

```markdown
# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

### Cameras
- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH
- home-server → 192.168.1.100, user: admin

### TTS
- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update
skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
```
