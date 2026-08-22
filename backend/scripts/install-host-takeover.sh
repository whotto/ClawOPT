#!/bin/bash
set -euo pipefail

TARGET_USER=""
HELPER_PATH="/usr/local/lib/openclaw-host-takeover/run"
SUDOERS_PATH=""

usage() {
  cat <<'EOF'
Usage: install-host-takeover.sh --user <username> [--helper-path <path>] [--sudoers-path <path>]

Installs the OpenClaw host takeover root helper and a matching sudoers drop-in.
This script must run as root.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      shift
      TARGET_USER="${1:-}"
      ;;
    --helper-path)
      shift
      HELPER_PATH="${1:-}"
      ;;
    --sudoers-path)
      shift
      SUDOERS_PATH="${1:-}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift || true
done

if [[ -z "$TARGET_USER" ]]; then
  echo "--user is required" >&2
  usage >&2
  exit 64
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 77
fi

if [[ -z "$SUDOERS_PATH" ]]; then
  SUDOERS_PATH="/etc/sudoers.d/openclaw-host-takeover-${TARGET_USER}"
fi

HELPER_DIR="$(dirname "$HELPER_PATH")"
SUDOERS_DIR="$(dirname "$SUDOERS_PATH")"
HELPER_TMP="$(mktemp)"
SUDOERS_TMP="$(mktemp)"

cleanup() {
  rm -f "$HELPER_TMP" "$SUDOERS_TMP"
}
trap cleanup EXIT

cat >"$HELPER_TMP" <<'EOF'
#!/bin/bash
set -euo pipefail

TARGET_USER=""
if [[ "${1:-}" == "--as-user" ]]; then
  shift
  TARGET_USER="${1:-}"
  if [[ -z "$TARGET_USER" ]]; then
    echo "Missing user after --as-user" >&2
    exit 64
  fi
  shift
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: run [--as-user USER] -- <command> [args...]" >&2
  exit 64
fi

if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$TARGET_USER" -- "$@"
  fi
  exec su -s /bin/sh "$TARGET_USER" -c "$(printf '%q ' "$@")"
fi

export HOME=/root
export USER=root
export LOGNAME=root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec "$@"
EOF

install -d "$HELPER_DIR"
install -m 0755 "$HELPER_TMP" "$HELPER_PATH"
chown root:root "$HELPER_PATH"

cat >"$SUDOERS_TMP" <<EOF
# Managed by ClawOPT host takeover.
${TARGET_USER} ALL=(root) NOPASSWD: ${HELPER_PATH}, ${HELPER_PATH} *
EOF

if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$SUDOERS_TMP" >/dev/null
fi

install -d "$SUDOERS_DIR"
install -m 0440 "$SUDOERS_TMP" "$SUDOERS_PATH"
chown root:root "$SUDOERS_PATH"

echo "Installed OpenClaw host takeover helper at $HELPER_PATH"
echo "Installed sudoers policy at $SUDOERS_PATH"
