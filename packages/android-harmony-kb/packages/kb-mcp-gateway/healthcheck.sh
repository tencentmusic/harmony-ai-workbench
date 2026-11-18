#!/usr/bin/env bash
# kb-mcp-for-zc 健康检查：GET /health 探活，连续 3 次失败则 pm2 restart。
# 进程不在 pm2 list 时直接 start ecosystem（机器重启 / pm2 resurrect 失败兜底）。
#
# crontab（deploy.sh 幂等注册）：
#   */5 * * * * PATH=... PM2_BIN=... /bin/bash .../packages/kb-mcp-gateway/healthcheck.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KB_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ECOSYSTEM="${SCRIPT_DIR}/ecosystem.config.cjs"
PROCESS_NAME="kb-mcp-for-zc"
STATE_DIR="${HOME}/.runtime"
LOG_DIR_BASE="${LOG_DIR_BASE:-$(
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "${HOME}/Library/Logs"
  else
    echo "${HOME}/.local/log"
  fi
)}"
LOG_FILE="${LOG_DIR_BASE}/kb-mcp-for-zc/healthcheck.log"
THRESHOLD=3
LOCK_DIR="/tmp/kb-mcp-for-zc-healthcheck.lock.d"

export PATH="${NODE_BIN_DIR:-${HOME}/.local/node/bin}:${PATH:-/usr/bin:/bin}"
PM2_BIN="${PM2_BIN:-pm2}"

# shellcheck disable=SC1091
if [[ -f "${SCRIPT_DIR}/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${SCRIPT_DIR}/.env.production"
  set +a
fi

PORT="${KB_MCP_PORT:-8420}"
HOST="${KB_MCP_HOST:-127.0.0.1}"

mkdir -p "${STATE_DIR}" "$(dirname "${LOG_FILE}")"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

if ! "${PM2_BIN}" describe "${PROCESS_NAME}" >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] ${PROCESS_NAME} missing from pm2 list, starting ecosystem" >> "${LOG_FILE}"
  "${PM2_BIN}" startOrReload "${ECOSYSTEM}" --update-env >> "${LOG_FILE}" 2>&1
  "${PM2_BIN}" save >> "${LOG_FILE}" 2>&1
  exit 0
fi

state_file="${STATE_DIR}/kb-mcp-for-zc-health.state"
consec=0
if [[ -f "${state_file}" ]]; then
  consec=$(cat "${state_file}" 2>/dev/null || echo 0)
  case "${consec}" in
    ''|*[!0-9]*) consec=0 ;;
  esac
fi

endpoint="http://${HOST}:${PORT}/health"
http=$(curl -sS -o /dev/null -w '%{http_code}' "${endpoint}" --max-time 15 2>/dev/null || echo "000")

if [[ "${http}" = "200" ]]; then
  if [[ "${consec}" -gt 0 ]]; then
    echo "[$(date '+%F %T')] recovered after ${consec} failures (HTTP 200)" >> "${LOG_FILE}"
  fi
  echo 0 > "${state_file}"
  exit 0
fi

consec=$((consec + 1))
echo "${consec}" > "${state_file}"
echo "[$(date '+%F %T')] failed (HTTP ${http}, consec=${consec}/${THRESHOLD}) ${endpoint}" >> "${LOG_FILE}"

if [[ "${consec}" -ge "${THRESHOLD}" ]]; then
  echo "[$(date '+%F %T')] threshold reached, restarting ${PROCESS_NAME}" >> "${LOG_FILE}"
  "${PM2_BIN}" restart "${PROCESS_NAME}" >> "${LOG_FILE}" 2>&1
  echo 0 > "${state_file}"
fi
