#!/bin/bash
# 在做任何可能改写 ~/.openclaw 配置的动作之前，照一张快照。
#
# 为什么不直接调 scripts/backup.sh：
#   那个脚本做的是**完整备份**——VACUUM INTO 整个 sqlite、tar 打包全部 workspace。
#   workspace 可能有几个 G，在升级链路的关键路径上跑它，是把一次几十毫秒的保险
#   变成一次几分钟的等待，慢到最后一定会有人加 `|| true` 把它绕过去。
#   这里要的是「把 doctor 即将改写的那几个文件复制走」，快到没有理由跳过。
#   backup.sh 仍然是 cron / 手动的完整备份工具，两者不重叠。
#
# 失败即失败：拿不到快照就不该继续迁移。调用方负责 fail closed。
#
# 用法：
#   bash scripts/snapshot-openclaw-config.sh [标签]
#   BACKUP_DIR=/mnt/x bash scripts/snapshot-openclaw-config.sh pre-update
# 成功时把快照目录路径打到 stdout（调用方可以捕获它，用于回滚）。

set -euo pipefail

LABEL="${1:-pre-migration}"
OPENCLAW_DIR="${HOME}/.openclaw"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/clawopt-backups}"
KEEP="${SNAPSHOT_KEEP:-10}"

CONFIG="${OPENCLAW_DIR}/openclaw.json"

# 没有配置就没什么可照的——这是合法状态（全新安装），不是失败。
if [ ! -f "$CONFIG" ]; then
    echo "没有 ${CONFIG}，跳过快照。" >&2
    exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/${LABEL}-${STAMP}"

# 同一秒内重复调用时不要互相覆盖。
SUFFIX=1
while [ -e "$DEST" ]; do
    DEST="${BACKUP_DIR}/${LABEL}-${STAMP}-${SUFFIX}"
    SUFFIX=$((SUFFIX + 1))
done

mkdir -p "$DEST"

# openclaw.json 是必须的；其余几个是 doctor / patch-config 也会动的，有就一并带走。
cp -p "$CONFIG" "${DEST}/openclaw.json"
for extra in exec-approvals.json auth-profiles.json; do
    [ -f "${OPENCLAW_DIR}/${extra}" ] && cp -p "${OPENCLAW_DIR}/${extra}" "${DEST}/${extra}"
done

# 快照里带凭据，权限跟着收紧——不能因为「这只是个备份」就放成 755。
chmod 700 "$DEST"

# 记一行元数据，方便三个月后有人打开这个目录时知道它是谁照的、为什么照。
{
    echo "label=${LABEL}"
    echo "created_at=$(date -Iseconds 2>/dev/null || date)"
    echo "source=${OPENCLAW_DIR}"
    echo "clawopt_ref=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "${DEST}/SNAPSHOT.txt"

# 只留最近 N 份，否则每次部署堆一个目录，半年后没人敢删。
if [ -d "$BACKUP_DIR" ]; then
    # shellcheck disable=SC2012
    ls -1dt "${BACKUP_DIR}/${LABEL}-"* 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
        rm -rf "$old"
    done
fi

echo "$DEST"
