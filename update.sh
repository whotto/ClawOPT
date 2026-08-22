#!/bin/bash
set -e

# Configuration
# If not in a project dir, default to ~/ClawOPT
INSTALL_DIR="$HOME/ClawOPT"

emit_phase() {
    echo "::clawopt-update-phase::$1"
}

require_linux_systemd_host() {
    local os_name
    os_name="$(uname -s 2>/dev/null || echo unknown)"
    if [ "$os_name" != "Linux" ]; then
        echo "Error: current OS is $os_name."
        echo "ClawOPT update currently supports only native Linux hosts with OpenClaw installed."
        echo "macOS does not provide systemd, so this script cannot upgrade the background service."
        exit 1
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "Error: systemctl was not found. Please update on a Linux host with user-level systemd."
        exit 1
    fi
}

require_linux_systemd_host

if [ -f "deploy-release.sh" ]; then
    PROJECT_ROOT="$(pwd)"
elif [ -d "$INSTALL_DIR" ]; then
    PROJECT_ROOT="$INSTALL_DIR"
else
    echo "Error: Could not find ClawOPT installation."
    echo "Checked: $(pwd) and $INSTALL_DIR"
    exit 1
fi

SERVICE_DIR="$HOME/.config/systemd/user"

echo "================================================"
echo "   ClawOPT - 更新脚本"
echo "================================================"

# 1. 从服务文件中探测现有端口
emit_phase "detect-service"
EXISTING_PORT=""
SERVICES=$(ls $SERVICE_DIR/clawopt-*.service 2>/dev/null | sort -V || true)

if [ -n "$SERVICES" ]; then
    # 使用找到的第一个服务端口作为默认值
    FIRST_SERVICE=$(echo "$SERVICES" | head -n 1)
    EXISTING_PORT=$(basename "$FIRST_SERVICE" | sed 's/clawopt-\([0-9]*\)\.service/\1/')
    echo "检测到正在运行的端口: $EXISTING_PORT"
else
    # 检查旧版服务文件
    if [ -f "$SERVICE_DIR/clawopt.service" ]; then
        EXISTING_PORT="3115"
        echo "检测到旧版安装 (端口 3115)"
    fi
fi

TARGET_PORT=${1:-$EXISTING_PORT}
TARGET_PORT=${TARGET_PORT:-3115}

emit_phase "git-pull"
cd "$PROJECT_ROOT"

# 升级前先记住当前位置，失败时能退回来。
PRE_UPDATE_REF="$(git rev-parse HEAD 2>/dev/null || true)"
[ -n "$PRE_UPDATE_REF" ] && echo "$PRE_UPDATE_REF" > /tmp/clawopt-pre-update-ref

git fetch origin main --tags

# 部署目标默认是**最新的发布 tag**，不是 main HEAD。
# 之前部署 main 会让「用户看到的版本号」与「实际跑的代码」对不上——
# 界面显示 v1.1.0，跑的却是 tag 之后的任意提交；预构建产物也会和源码错版。
# 需要跟 main 的（开发机）显式设 CLAWOPT_TARGET_REF=main。
TARGET_REF="${CLAWOPT_TARGET_REF:-}"
if [ -z "$TARGET_REF" ]; then
    TARGET_REF="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
    [ -z "$TARGET_REF" ] && TARGET_REF="origin/main"
fi
echo "正在同步代码到 $TARGET_REF，目录: $PROJECT_ROOT..."
git reset --hard "$TARGET_REF"
git clean -fd
export CLAWOPT_DEPLOY_REF="$TARGET_REF"

emit_phase "deploy-release"
echo "开始升级端口 $TARGET_PORT 的服务..."
if ! ./deploy-release.sh "$TARGET_PORT"; then
    # 失败就退回升级前那个提交。不回滚的话，工作区已经是新代码、dist 可能是半成品，
    # 而 systemd 的 Restart=always 会拿着坏产物每 10 秒崩一次。
    echo "升级失败，正在回滚到升级前的版本..." >&2
    if [ -s /tmp/clawopt-pre-update-ref ]; then
        git reset --hard "$(cat /tmp/clawopt-pre-update-ref)" && git clean -fd
        echo "已回滚到 $(cat /tmp/clawopt-pre-update-ref)，正在用回滚后的代码重启服务..." >&2
        ./deploy-release.sh "$TARGET_PORT" || echo "回滚后的重新部署也失败了，需要人工介入。" >&2
    else
        echo "没有记录到升级前的提交，无法自动回滚。" >&2
    fi
    exit 1
fi

emit_phase "complete"
echo "================================================"
echo "升级完成！"
echo "您的配置和数据已保留。"
echo "================================================"
