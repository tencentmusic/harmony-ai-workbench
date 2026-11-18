#!/usr/bin/env bash
# 首次部署前准备 opencode workspace 目录（deploy.sh 也会自动执行，本脚本可单独跑）。
#
# 用法：
#   bash runtime/opencode/prepare-workspace.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTANCE_CFG="${REPO_ROOT}/runtime/agents/harmony/instance.json"

[[ -f "${INSTANCE_CFG}" ]] || { echo "ERROR: 缺失 ${INSTANCE_CFG}"; exit 1; }
CWD_RAW=$(jq -r '.cwd' "${INSTANCE_CFG}")
CWD=$(echo "${CWD_RAW}" | envsubst 2>/dev/null || echo "${CWD_RAW//\$\{HOME\}/${HOME}}")

node "${REPO_ROOT}/scripts/prepare-opencode-workspace.mjs" "${CWD}"
