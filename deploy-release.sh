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
# 产物必须和当前检出的代码同一个 tag。之前是「拉 latest release 的产物、解到 main HEAD
# 的代码树上」——前端产物和后端源码来自两个提交，出问题时无从判断谁对谁错。
REL_TAG="${CLAWOPT_DEPLOY_REF:-}"
case "$REL_TAG" in
    v*) ;;                     # 明确的发布 tag，可以用它的预构建产物
    *)  REL_TAG="$(git describe --tags --exact-match 2>/dev/null || true)" ;;
esac
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
else
    echo "· 当前检出不是发布 tag（或已强制本地构建），跳过预构建产物"
fi

# 小内存主机上本地全量构建是已知的事故源：前端 vite 峰值约 1GB，
# 2GB 机器会进 swap 风暴，连 sshd 都可能失去响应。
if [ "$PREBUILT_OK" != "1" ]; then
    AVAIL_MB="$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
    if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt 1200 ] && [ "${CLAWOPT_ALLOW_LOCAL_BUILD:-0}" != "1" ]; then
        echo "" >&2
        echo "拒绝在本机构建：可用内存仅 ${AVAIL_MB}MB，前端构建峰值约 1GB。" >&2
        echo "  · 优先做法：等这个版本的 Release 传完预构建产物，再升级" >&2
        echo "  · 确实要在本机构建：CLAWOPT_ALLOW_LOCAL_BUILD=1 ./deploy-release.sh $CLAWOPT_PORT" >&2
        exit 1
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
# ExecStart 与 PATH 都指向 OpenClaw 自带 Node
# ExecStart：backend 的 better-sqlite3 / sharp 按该版本 ABI 编译
# PATH：backend 会 spawn `openclaw` CLI（版本检查、网关重启），
#       该 CLI 要求 Node >=22.22.3，PATH 里若系统 Node 在前会直接失败
if [ -n "$OC_NODE_DIR" ]; then
    sed -i "s|^ExecStart=.*|ExecStart=$OC_NODE_DIR/node dist/index.js|" "$SERVICE_DIR/$SERVICE_NAME.service"
    sed -i "s|^Environment=PATH=.*|Environment=PATH=$OC_NODE_DIR:$HOME/.openclaw/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" "$SERVICE_DIR/$SERVICE_NAME.service"
fi
sed -i "s/Description=.*/Description=ClawOPT Service (Port $CLAWOPT_PORT)/" "$SERVICE_DIR/$SERVICE_NAME.service"
if grep -q '^Environment=PATH=' "$SERVICE_DIR/$SERVICE_NAME.service"; then
    # 仅在没有 OpenClaw 自带 Node 时才用系统 PATH（上面已处理有的情况）
    [ -z "$OC_NODE_DIR" ] && sed -i "s|^Environment=PATH=.*|Environment=PATH=$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" "$SERVICE_DIR/$SERVICE_NAME.service"
else
    sed -i "/Environment=NODE_ENV=.*/a Environment=PATH=${OC_NODE_DIR:+$OC_NODE_DIR:}$HOME/.openclaw/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "$SERVICE_DIR/$SERVICE_NAME.service"
fi

echo "Reloading systemd daemon..."
systemctl --user daemon-reload

echo "Enabling service $SERVICE_NAME..."
systemctl --user enable "$SERVICE_NAME.service"

if [ "$SKIP_SERVICE_RESTART" = "1" ]; then
    echo "Skipping service restart because CLAWOPT_SKIP_SERVICE_RESTART=1"
else
    # ── 迁移闸门（S2-A5）────────────────────────────────────────────
    # OpenClaw 2026.8 换了配置 schema（agents.list → agents.entries）与会话存储。
    # 引擎已经是 2.x 而配置里还留着废弃键时，**必须先跑 doctor 迁移，再重启 gateway**——
    # 顺序反了的话，gateway 带着半旧的配置起来，行为不可预测。
    #
    # 退出码必须校验。AGENTS.md：「升级成功」不得只以 build 完成为准。
    # 这里失败**阻断部署**，不是打一句 Warning——一次没跑成的迁移，
    # 和一次跑成了的迁移，在日志里长得一模一样。
    #
    # 另有一个上游坑：`doctor --fix` 在没有 TTY 时曾静默跳过 2.0 迁移
    # （通过 ssh 或自动化调用正好是这种情形，upstream 记为 P1 并已修）。
    # 所以显式传 --non-interactive，并且**校验退出码**，不假设它做了事。
    emit_phase "openclaw-migration-gate"
    if command -v openclaw >/dev/null 2>&1 && [ -f "$HOME/.openclaw/openclaw.json" ]; then
        NEEDS_MIGRATION="$(node "$PROJECT_ROOT/scripts/needs-openclaw-migration.mjs" 2>/dev/null || echo "unknown")"
        case "$NEEDS_MIGRATION" in
            yes)
                echo "检测到引擎已是 2026.8+ 且配置里仍有废弃键，先跑迁移..."
                if ! openclaw doctor --fix --non-interactive; then
                    echo "错误：openclaw doctor --fix 失败（退出码 $?）。" >&2
                    echo "  配置可能处于迁移到一半的状态，**不继续重启 gateway**。" >&2
                    echo "  手动处理后重跑本脚本；升级前快照见 ~/clawopt-backups/。" >&2
                    exit 1
                fi
                echo "迁移完成。"
                ;;
            no)
                echo "无需迁移（引擎与配置 schema 一致）。"
                ;;
            *)
                # 判断不了就说出来，不猜。跑一次多余的 doctor 比带着未知状态重启安全，
                # 但那是用户的选择，不是脚本替他做的决定。
                echo "Warning: 判断不出是否需要迁移（$NEEDS_MIGRATION）；未自动跑 doctor。" >&2
                echo "  若刚升过 OpenClaw，建议手动跑一次：openclaw doctor --fix" >&2
                ;;
        esac
    fi

    emit_phase "restart-openclaw-runtime"
    echo "Restarting OpenClaw gateway..."
    if command -v openclaw >/dev/null 2>&1; then
        # 收敛脚本做的是裸 restart 做不到的三件事：对齐 systemd unit 的可执行路径
        # （OpenClaw CLI 升级后路径会变）、自动批准本机 device repair、验证浏览器运行时。
        # AGENTS.md 一直把这三件写成「升级成功」的必要条件，但这个脚本此前没有任何
        # 调用点——契约写着、代码不跑。接回来，跑不通也不阻断升级。
        if [ -f "$PROJECT_ROOT/scripts/reconcile-openclaw-runtime.mjs" ]; then
            node "$PROJECT_ROOT/scripts/reconcile-openclaw-runtime.mjs" \
                || echo "Warning: OpenClaw runtime reconciliation reported problems; continuing."
        else
            openclaw gateway restart --json || openclaw gateway restart || echo "Warning: Failed to restart OpenClaw gateway automatically."
        fi
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
