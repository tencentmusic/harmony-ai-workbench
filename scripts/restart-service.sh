#!/usr/bin/env bash
# PM2 启动或 reload harmony-workbench
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-repo-env.sh"
load_repo_env "${ROOT_DIR}" || true

export PATH="${NODE_BIN_DIR:-${HOME}/.local/node/bin}:${PATH:-/usr/bin:/bin}"

exec node "${SCRIPT_DIR}/restart-service.mjs"
