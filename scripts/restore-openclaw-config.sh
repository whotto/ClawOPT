#!/bin/bash
# 把 ~/.openclaw 的配置恢复成某一份快照的样子。
#
# 用在 update.sh 的回滚分支：那里 `git reset --hard` 只把**代码**退回升级前，
# 而升级链路中的迁移闸门已经跑过 `openclaw doctor --fix`，配置已经被迁到新 schema。
# 不恢复配置的话，「回滚成功」之后是 1.x 的代码配 2.x 的配置。
#
# 三条硬规矩：
#   1. 必须显式指定恢复哪一份，不猜（快照目录里可能有十份）。
#   2. 覆盖之前先把**当前这份**照下来（superseded-*）。恢复不是销毁——
#      万一「回滚」本身才是错的决定，迁移到一半的现场还得找得回来。
#   3. 快照不完整就拒绝，且一个字节都不碰现有配置。
#
# 用法：
#   bash scripts/restore-openclaw-config.sh <快照目录>

set -euo pipefail

SNAPSHOT_DIR="${1:-}"
OPENCLAW_DIR="${HOME}/.openclaw"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$SNAPSHOT_DIR" ]; then
    echo "用法：restore-openclaw-config.sh <快照目录>" >&2
    echo "  不传参数时不做任何事——恢复哪一份必须是调用方的明确决定。" >&2
    exit 64
fi

if [ ! -d "$SNAPSHOT_DIR" ]; then
    echo "错误：快照目录不存在：${SNAPSHOT_DIR}" >&2
    echo "  现有配置未被改动。" >&2
    exit 1
fi

if [ ! -f "${SNAPSHOT_DIR}/openclaw.json" ]; then
    echo "错误：快照里没有 openclaw.json：${SNAPSHOT_DIR}" >&2
    echo "  这份快照不完整，拒绝用它覆盖现有配置。现有配置未被改动。" >&2
    exit 1
fi

# 覆盖之前先留退路。这一步失败就整个放弃——没有退路的恢复不该开始，
# 和迁移闸门「照不上快照就不迁移」是同一条判据。
if [ -f "${OPENCLAW_DIR}/openclaw.json" ]; then
    if ! SUPERSEDED="$(bash "${HERE}/snapshot-openclaw-config.sh" superseded)"; then
        echo "错误：无法为当前配置留存副本，**不执行恢复**。" >&2
        exit 1
    fi
    [ -n "$SUPERSEDED" ] && echo "被覆盖的那份已留存：${SUPERSEDED}"
fi

mkdir -p "$OPENCLAW_DIR"
for name in openclaw.json exec-approvals.json auth-profiles.json; do
    [ -f "${SNAPSHOT_DIR}/${name}" ] && cp -p "${SNAPSHOT_DIR}/${name}" "${OPENCLAW_DIR}/${name}"
done

echo "已把配置恢复到：${SNAPSHOT_DIR}"
