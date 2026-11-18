#!/usr/bin/env bash
# opencode-harmony 实例启动脚本模板。
#
# 由 ecosystem.config.cjs 渲染占位符（NAME/CWD/HOST/PORT/REPO_ROOT），
# 产物落到 runtime/opencode/.runtime/start.<name>.sh。
#
# 与 portal 版关键差异：
#   - 使用 OPENCODE_CONFIG_DIR 指向本仓库 .runtime/opencode-config/（不写 ~/.config/opencode/）
#   - source 工台仓库根 env（与 deploy-background.mjs 同序：.env.production → .env.local → .env）
set -euo pipefail

NAME="${NAME}"
CWD="${CWD}"
HOST="${HOST}"
PORT="${PORT}"
REPO_ROOT="${REPO_ROOT}"
CONFIG_DIR="${CONFIG_DIR}"
XDG_CONFIG_HOME_CONTROLLED="${XDG_CONFIG_HOME}"
INTEGRATION_RUNTIME="${INTEGRATION_RUNTIME}"

NODE_BIN_DIR="${NODE_BIN_DIR:-${HOME}/.local/node/bin}"
export PATH="${NODE_BIN_DIR}:${PATH:-/usr/bin:/bin}"

LOAD_ENV_SH="${REPO_ROOT}/runtime/opencode/load-repo-env.sh"
if [[ -f "${LOAD_ENV_SH}" ]]; then
  # shellcheck disable=SC1091
  source "${LOAD_ENV_SH}"
  load_repo_env "${REPO_ROOT}" || true
fi

readonly RUNTIME_OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
readonly RUNTIME_OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
readonly RUNTIME_INTEGRATION_SERVER_USERNAME="${OPENCODE_INTEGRATION_SERVER_USERNAME:-opencode}"
readonly RUNTIME_INTEGRATION_SERVER_PASSWORD="${OPENCODE_INTEGRATION_SERVER_PASSWORD:-}"

INSTANCE_ENV="${CWD}/.env.local"
if [[ "$INTEGRATION_RUNTIME" != "true" && -f "${INSTANCE_ENV}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${INSTANCE_ENV}"
  set +a
fi

# Security boundary: workspace/repository env files must never replace the
# controlled profile or inject managed config after they have been sourced.
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_PERMISSION
export XDG_CONFIG_HOME="$XDG_CONFIG_HOME_CONTROLLED"
export OPENCODE_CONFIG_DIR="$CONFIG_DIR"
export OPENCODE_SERVER_USERNAME="$RUNTIME_OPENCODE_SERVER_USERNAME"
export OPENCODE_SERVER_PASSWORD="$RUNTIME_OPENCODE_SERVER_PASSWORD"
export OPENCODE_INTEGRATION_SERVER_USERNAME="$RUNTIME_INTEGRATION_SERVER_USERNAME"
export OPENCODE_INTEGRATION_SERVER_PASSWORD="$RUNTIME_INTEGRATION_SERVER_PASSWORD"

if [[ "$HOST" != "127.0.0.1" ]]; then
  echo "[opencode-${NAME}] refusing non-loopback host: $HOST" >&2
  exit 1
fi

if [[ "$INTEGRATION_RUNTIME" == "true" ]]; then
  : "${OPENCODE_INTEGRATION_SERVER_PASSWORD:?OPENCODE_INTEGRATION_SERVER_PASSWORD is required}"
  : "${SUB2API_API_KEY:?SUB2API_API_KEY is required for the pinned integration model}"
  if [[ ! "$OPENCODE_INTEGRATION_SERVER_PASSWORD" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "[opencode-${NAME}] integration server password must be 64 hexadecimal characters" >&2
    exit 1
  fi
  [[ "$OPENCODE_INTEGRATION_SERVER_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || exit 1
  export OPENCODE_SERVER_USERNAME="${OPENCODE_INTEGRATION_SERVER_USERNAME:-opencode}"
  export OPENCODE_SERVER_PASSWORD="$OPENCODE_INTEGRATION_SERVER_PASSWORD"
  export OPENCODE_DISABLE_CLAUDE_CODE=true
  export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true
  export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
  export OPENCODE_DISABLE_AUTOUPDATE=true
  INTEGRATION_HOME="${REPO_ROOT}/.runtime/opencode-integration-home"
  export XDG_DATA_HOME="${REPO_ROOT}/.runtime/opencode-integration-data"
  export XDG_CACHE_HOME="${REPO_ROOT}/.runtime/opencode-integration-cache"
  export XDG_STATE_HOME="${REPO_ROOT}/.runtime/opencode-integration-state"
  mkdir -p "$INTEGRATION_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  chmod 700 "$INTEGRATION_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
else
  : "${OPENCODE_SERVER_PASSWORD:?OPENCODE_SERVER_PASSWORD is required}"
  if [[ ! "$OPENCODE_SERVER_PASSWORD" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "[opencode-${NAME}] server password must be 64 hexadecimal characters" >&2
    exit 1
  fi
  [[ "$OPENCODE_SERVER_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || exit 1
  export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
fi

cd "${CWD}"

echo "[opencode-${NAME}] starting at $(date '+%F %T')"
echo "[opencode-${NAME}] cwd=${CWD}"
echo "[opencode-${NAME}] OPENCODE_CONFIG_DIR=${OPENCODE_CONFIG_DIR}"
echo "[opencode-${NAME}] integrationRuntime=$INTEGRATION_RUNTIME"
echo "[opencode-${NAME}] node=$(command -v node) version=$(node -v 2>/dev/null || echo missing)"
echo "[opencode-${NAME}] opencode=$(command -v opencode)"

if [[ "$INTEGRATION_RUNTIME" == "true" ]]; then
  exec env -i \
    HOME="$INTEGRATION_HOME" \
    PATH="$PATH" \
    LANG="${LANG:-C.UTF-8}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    XDG_DATA_HOME="$XDG_DATA_HOME" \
    XDG_CACHE_HOME="$XDG_CACHE_HOME" \
    XDG_STATE_HOME="$XDG_STATE_HOME" \
    OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR" \
    OPENCODE_SERVER_USERNAME="$OPENCODE_SERVER_USERNAME" \
    OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    SUB2API_API_KEY="$SUB2API_API_KEY" \
    OPENAI_API_KEY="$SUB2API_API_KEY" \
    opencode serve --hostname "$HOST" --port "$PORT"
fi

unset OPENCODE_INTEGRATION_SERVER_USERNAME OPENCODE_INTEGRATION_SERVER_PASSWORD
exec opencode serve --hostname "$HOST" --port "$PORT"
