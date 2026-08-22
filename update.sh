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
echo "正在从 GitHub 强制同步代码，目录: $PROJECT_ROOT..."
cd "$PROJECT_ROOT"
git fetch origin main --tags
git reset --hard origin/main
git clean -fd

emit_phase "deploy-release"
echo "开始升级端口 $TARGET_PORT 的服务..."
./deploy-release.sh "$TARGET_PORT"

emit_phase "complete"
echo "================================================"
echo "升级完成！"
echo "您的配置和数据已保留。"
echo "================================================"
