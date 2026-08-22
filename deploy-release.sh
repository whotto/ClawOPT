#!/bin/bash
set -e

# Configuration
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SERVICE_DIR="$HOME/.config/systemd/user"
SKIP_SERVICE_RESTART=${CLAWOPT_SKIP_SERVICE_RESTART:-0}
BROWSER_WARMUP_MARKER="$HOME/${CLAWOPT_DATA_DIR:-.clawopt}/browser-warmup.pending"

# Node 解析顺序：OpenClaw 自带 Node 优先
# 原因：backend 的 better-sqlite3 / sharp 是按该版本 ABI 编译的，
#      退回系统 Node（可能是 v20）会直接加载失败。
OC_NODE_DIR="$(ls -d "$HOME"/.openclaw/tools/node-v*/bin 2>/dev/null | sort -V | tail -1)"
if [ -n "$OC_NODE_DIR" ]; then
    export PATH="$OC_NODE_DIR:$PATH"
    echo "使用 OpenClaw 自带 Node: $("$OC_NODE_DIR/node" -v)"
fi
export PATH="$PATH:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

emit_phase() {
    echo "::clawopt-update-phase::$1"
}

restore_deploy_lockfiles() {
    git restore -- package-lock.json backend/package-lock.json frontend/package-lock.json 2>/dev/null || true
}

require_linux_systemd_host() {
    local os_name
    os_name="$(uname -s 2>/dev/null || echo unknown)"
    if [ "$os_name" != "Linux" ]; then
        echo "Error: current OS is $os_name."
        echo "ClawOPT deployment currently supports only native Linux hosts with OpenClaw installed."
        echo "macOS does not provide systemd, so this script cannot install the background service."
        exit 1
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "Error: systemctl was not found. Please deploy on a Linux host with user-level systemd."
        exit 1
    fi
}

# Default Port
CLAWOPT_PORT=${1:-3115}
SERVICE_NAME="clawopt-${CLAWOPT_PORT}"

require_linux_systemd_host

# Build steps need devDependencies even when the service environment sets NODE_ENV=production.
export NPM_CONFIG_PRODUCTION=false
export npm_config_production=false
export NPM_CONFIG_INCLUDE=dev
export npm_config_include=dev

emit_phase "install-dependencies"
echo "Deploying ClawOPT (Consolidated)..."
echo "Project Path:  $PROJECT_ROOT"
echo "Service Port:  $CLAWOPT_PORT"
echo "Service Name:  $SERVICE_NAME"

echo "Installing dependencies..."
cd "$PROJECT_ROOT"
# ── 优先使用预构建产物（小内存主机友好）──
# 前端 vite build 峰值约 1GB 内存 + 312MB 依赖。
# 若 GitHub Release 提供了 dist 产物，直接下载解压，跳过整个构建链。
PREBUILT_OK=0
REL_TAG="$(curl -fsSL -m 20 https://api.github.com/repos/whotto/ClawOPT/releases/latest 2>/dev/null \
           | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)"
if [ -n "$REL_TAG" ] && [ "${CLAWOPT_FORCE_BUILD:-0}" != "1" ]; then
    ART="https://github.com/whotto/ClawOPT/releases/download/${REL_TAG}/clawopt-dist-${REL_TAG}.tgz"
    echo "尝试预构建产物: $REL_TAG"
    if curl -fsSL -m 120 "$ART" -o /tmp/clawopt-dist.tgz 2>/dev/null; then
        tar -xzf /tmp/clawopt-dist.tgz -C . && PREBUILT_OK=1
        rm -f /tmp/clawopt-dist.tgz
        echo "✓ 已使用预构建产物，跳过前端构建"
    else
        echo "· 无预构建产物，回退到本地构建"
    fi
fi

if [ "$PREBUILT_OK" = "1" ]; then
    # 只装后端运行时依赖（7 个），不装 dev、不装前端
    cd backend && npm install --omit=dev --no-audit --no-fund && cd ..
else
    npm install --include=dev
    cd backend && npm install --include=dev && cd ..
    cd frontend && npm install --include=dev && cd ..
fi

emit_phase "build"
echo "Building projects..."
if [ "$PREBUILT_OK" = "1" ]; then echo "跳过构建（已用预构建产物）"; else npm run build; fi
restore_deploy_lockfiles

emit_phase "patch-config"
echo "Patching OpenClaw configuration for local backend connections..."
node backend/patch-config.js || echo "Warning: Failed to patch OpenClaw config automatically."

emit_phase "setup-service"
echo "Setting up systemd service..."
mkdir -p "$SERVICE_DIR"

# Clean up old services if they exist (legacy single service name)
if [ "$CLAWOPT_PORT" == "3115" ] && [ -f "$SERVICE_DIR/clawopt.service" ]; then
    echo "Transitioning from legacy clawopt.service to $SERVICE_NAME.service..."
    systemctl --user stop clawopt.service 2>/dev/null || true
    systemctl --user disable clawopt.service 2>/dev/null || true
    rm -f "$SERVICE_DIR/clawopt.service"
fi

# Copy and update the consolidated service file
cp "$PROJECT_ROOT/clawopt.service" "$SERVICE_DIR/$SERVICE_NAME.service"

# Update WorkingDirectory, Port, and Description in the service file
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_ROOT/backend|" "$SERVICE_DIR/$SERVICE_NAME.service"
sed -i "s/Environment=PORT=.*/Environment=PORT=$CLAWOPT_PORT/" "$SERVICE_DIR/$SERVICE_NAME.service"
# ExecStart 指向 OpenClaw 自带 Node（原生模块 ABI 依赖）
if [ -n "$OC_NODE_DIR" ]; then
    sed -i "s|^ExecStart=.*|ExecStart=$OC_NODE_DIR/node dist/index.js|" "$SERVICE_DIR/$SERVICE_NAME.service"
fi
sed -i "s/Description=.*/Description=ClawOPT Service (Port $CLAWOPT_PORT)/" "$SERVICE_DIR/$SERVICE_NAME.service"
if grep -q '^Environment=PATH=' "$SERVICE_DIR/$SERVICE_NAME.service"; then
    sed -i "s|^Environment=PATH=.*|Environment=PATH=$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" "$SERVICE_DIR/$SERVICE_NAME.service"
else
    sed -i "/Environment=NODE_ENV=.*/a Environment=PATH=$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "$SERVICE_DIR/$SERVICE_NAME.service"
fi

echo "Reloading systemd daemon..."
systemctl --user daemon-reload

echo "Enabling service $SERVICE_NAME..."
systemctl --user enable "$SERVICE_NAME.service"

if [ "$SKIP_SERVICE_RESTART" = "1" ]; then
    echo "Skipping service restart because CLAWOPT_SKIP_SERVICE_RESTART=1"
else
    emit_phase "restart-openclaw-runtime"
    echo "Restarting OpenClaw gateway..."
    if command -v openclaw >/dev/null 2>&1; then
        openclaw gateway restart --json || openclaw gateway restart || echo "Warning: Failed to restart OpenClaw gateway automatically."
    else
        echo "Warning: openclaw command not found in PATH; skipped gateway restart."
    fi

    emit_phase "service-restart"
    echo "Restarting service $SERVICE_NAME..."
    mkdir -p "$(dirname "$BROWSER_WARMUP_MARKER")"
    touch "$BROWSER_WARMUP_MARKER"
    systemctl --user restart "$SERVICE_NAME.service"
fi

# Ensure services stay running after logout
echo "Enabling lingering for user $(whoami)..."
if command -v loginctl >/dev/null 2>&1; then
    sudo -n loginctl enable-linger $(whoami) || echo "Warning: Could not enable lingering. Manual action may be required: sudo loginctl enable-linger $(whoami)"
fi

# Get local IP address
LOCAL_IP=$(hostname -I | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="localhost"

echo "------------------------------------------------"
echo "Deployment complete!"
echo "Local Access:   http://localhost:$CLAWOPT_PORT"
echo "Network Access: http://$LOCAL_IP:$CLAWOPT_PORT"
echo "------------------------------------------------"
echo "Check status with: systemctl --user status $SERVICE_NAME"
