#!/bin/bash
set -e

# Configuration
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SERVICE_DIR="$HOME/.config/systemd/user"
SKIP_SERVICE_RESTART=${CLAWOPT_SKIP_SERVICE_RESTART:-0}
BROWSER_WARMUP_MARKER="$HOME/${CLAWOPT_DATA_DIR:-.clawopt}/browser-warmup.pending"

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

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
npm install --include=dev
cd backend && npm install --include=dev && cd ..
cd frontend && npm install --include=dev && cd ..

emit_phase "build"
echo "Building projects..."
npm run build
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
