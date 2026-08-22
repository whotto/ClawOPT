#!/usr/bin/env bash
# ClawOPT 数据备份。
#
# 备的是三样：SQLite 库（会话、群组、消息、配置）、各智能体工作区
# （SOUL/USER/AGENTS/MEMORY/skills，也就是「一键复制」里那些内容），
# 以及 openclaw.json 的**脱敏副本**——原件带模型 API key，不进备份。
#
# SQLite 用 VACUUM INTO 做在线备份，不用 cp：cp 一个正在写入的库会拷到撕裂的
# 中间状态，而这种损坏通常到恢复那天才发现。
#
# 用法：
#   bash scripts/backup.sh                 备份到 ~/clawopt-backups
#   BACKUP_DIR=/mnt/x bash scripts/backup.sh
#   装进 cron（每天 4 点，保留 7 份）：
#   0 4 * * * bash /root/ClawOPT/scripts/backup.sh >> /var/log/clawopt-backup.log 2>&1
set -euo pipefail

DATA_DIR="${CLAWOPT_DATA_DIR:-.clawopt_release}"
DB_PATH="${HOME}/${DATA_DIR}/clawopt.sqlite"
OPENCLAW_DIR="${HOME}/.openclaw"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/clawopt-backups}"
KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/${STAMP}"

mkdir -p "$DEST"

# 1) 数据库
if [ -f "$DB_PATH" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_PATH" "VACUUM INTO '${DEST}/clawopt.sqlite'"
    else
        # 没有 sqlite3 就退到 .backup 语义最接近的做法：连 WAL 一起拷，
        # 恢复时 SQLite 能自行重放。仍好过裸 cp 单个 .sqlite。
        cp "$DB_PATH" "${DEST}/clawopt.sqlite"
        [ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${DEST}/" || true
        [ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${DEST}/" || true
        echo "· 未安装 sqlite3，已用文件拷贝（建议 apt install sqlite3 以获得在线一致备份）"
    fi
    echo "✓ 数据库已备份"
else
    echo "· 未找到数据库 $DB_PATH，跳过"
fi

# 2) 工作区（智能体人格、记忆、技能）
if [ -d "$OPENCLAW_DIR" ]; then
    tar -czf "${DEST}/workspaces.tgz" -C "$OPENCLAW_DIR" \
        $(cd "$OPENCLAW_DIR" && ls -d workspace-* 2>/dev/null || true) 2>/dev/null \
        && echo "✓ 工作区已备份" || echo "· 没有工作区目录，跳过"

    # 3) openclaw.json 脱敏副本：结构留着方便恢复，密钥一律抹掉
    if [ -f "${OPENCLAW_DIR}/openclaw.json" ] && command -v python3 >/dev/null 2>&1; then
        python3 - "$OPENCLAW_DIR/openclaw.json" "${DEST}/openclaw.redacted.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
SECRET_KEYS = {'apikey', 'api_key', 'token', 'password', 'secret', 'accesskey'}
def scrub(node):
    if isinstance(node, dict):
        return {k: ('[redacted]' if k.lower() in SECRET_KEYS and isinstance(v, str) else scrub(v)) for k, v in node.items()}
    if isinstance(node, list):
        return [scrub(x) for x in node]
    return node
try:
    with open(src, encoding='utf-8') as f:
        data = json.load(f)
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(scrub(data), f, ensure_ascii=False, indent=2)
    print('✓ openclaw.json 已备份（密钥已抹除）')
except Exception as error:
    print(f'· openclaw.json 备份失败：{error}')
PY
    fi
fi

# 4) 滚动保留
cd "$BACKUP_DIR"
COUNT=$(ls -1d */ 2>/dev/null | wc -l)
if [ "$COUNT" -gt "$KEEP" ]; then
    ls -1d */ | sort | head -n "$((COUNT - KEEP))" | while read -r old; do
        rm -rf "$old"
        echo "· 已清理旧备份 $old"
    done
fi

SIZE=$(du -sh "$DEST" | cut -f1)
echo "备份完成：${DEST}（${SIZE}），保留最近 ${KEEP} 份"
