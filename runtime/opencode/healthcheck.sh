#!/usr/bin/env bash
# opencode-harmony 健康检查：GET /global/health 探活，连续 3 次失败则 pm2 restart。
#
# crontab（deploy.sh 幂等注册）：
#   */5 * * * * /path/to/workbench/runtime/opencode/healthcheck.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_DIR="${REPO_ROOT}/runtime/agents"
STATE_DIR="${HOME}/.runtime"
LOG_DIR_BASE="${LOG_DIR_BASE:-$(
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "${HOME}/Library/Logs"
  else
    echo "${HOME}/.local/log"
  fi
)}"
PM2_BIN="${PM2_BIN:-${HOME}/.local/node/bin/pm2}"
JQ_BIN="${JQ_BIN:-$(command -v jq 2>/dev/null || true)}"
THRESHOLD=3
LOCK_DIR="${OPENCODE_HEALTHCHECK_LOCK_DIR:-/tmp/opencode-harmony-healthcheck-${UID}.lock.d}"
LOCK_PID_FILE="${LOCK_DIR}/pid"
FAIL=0

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-repo-env.sh"
source "${SCRIPT_DIR}/agent-backend-mode.sh"
source "${SCRIPT_DIR}/curl-basic-auth.sh"
load_repo_env "${REPO_ROOT}" >/dev/null || true
HARMONY_BACKEND="$(normalize_harmony_agent_backend)"
if is_cursor_agent_backend; then
  export OPENCODE_INSTANCE_MODE=integration
fi

mkdir -p "${STATE_DIR}"

if [[ "${LOCK_DIR}" != /* || "${LOCK_DIR}" = "/" ]]; then
  echo "healthcheck lock path 必须是非根绝对路径" >&2
  exit 1
fi

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  if [[ ! -d "${LOCK_DIR}" || -L "${LOCK_DIR}" ]]; then
    echo "healthcheck lock 不是安全目录：${LOCK_DIR}" >&2
    exit 1
  fi
  if [[ -e "${LOCK_PID_FILE}" && ( -L "${LOCK_PID_FILE}" || ! -f "${LOCK_PID_FILE}" ) ]]; then
    echo "healthcheck lock pid 不是安全普通文件：${LOCK_PID_FILE}" >&2
    exit 1
  fi
  lock_pid=$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)
  if [[ "${lock_pid}" =~ ^[0-9]+$ ]] && kill -0 "${lock_pid}" 2>/dev/null; then
    exit 0
  fi
  rm -f "${LOCK_PID_FILE}" || exit 1
  rmdir "${LOCK_DIR}" 2>/dev/null || exit 1
  mkdir "${LOCK_DIR}" 2>/dev/null || exit 1
fi
chmod 700 "${LOCK_DIR}"
printf '%s\n' "$$" > "${LOCK_PID_FILE}"
trap 'rm -f "${LOCK_PID_FILE}"; rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

if [[ -z "${JQ_BIN}" || ! -x "${JQ_BIN}" ]]; then
  echo "jq 不在 healthcheck PATH 中" >&2
  exit 1
fi

probe_instance() {
  local name="$1"
  local port="$2"
  local integration_runtime="$3"
  local endpoint="http://127.0.0.1:${port}/global/health"
  local state_file="${STATE_DIR}/opencode-health-${name}.state"
  local log_file="${LOG_DIR_BASE}/opencode-${name}/healthcheck.log"
  mkdir -p "$(dirname "${log_file}")"

  # 进程级兜底：pm2 list 里压根没 opencode-${name}（机器重启 + resurrect 失败 /
  # dump.pm2 丢失后会出现），直接 start ecosystem 并 save，跳过 probe。
  if ! "${PM2_BIN}" describe "opencode-${name}" >/dev/null 2>&1; then
    echo "[$(date '+%F %T')] [${name}] opencode-${name} missing from pm2 list, starting ecosystem" >> "${log_file}"
    if "${PM2_BIN}" start "${SCRIPT_DIR}/ecosystem.config.cjs" >> "${log_file}" 2>&1 && \
      "${PM2_BIN}" save >> "${log_file}" 2>&1; then
      echo 0 > "${state_file}"
      return 0
    fi
    echo "${THRESHOLD}" > "${state_file}"
    echo "[$(date '+%F %T')] [${name}] pm2 start/save failed" >> "${log_file}"
    return 1
  fi

  local consec=0
  if [[ -f "${state_file}" ]]; then
    consec=$(cat "${state_file}" 2>/dev/null || echo 0)
    case "${consec}" in
      ''|*[!0-9]*) consec=0 ;;
    esac
  fi

  local http
  local probe_username
  local probe_password
  if [[ "${integration_runtime}" = "true" ]]; then
    probe_username="${OPENCODE_INTEGRATION_SERVER_USERNAME:-opencode}"
    probe_password="${OPENCODE_INTEGRATION_SERVER_PASSWORD:-}"
  else
    probe_username="${OPENCODE_SERVER_USERNAME:-opencode}"
    probe_password="${OPENCODE_SERVER_PASSWORD:-}"
  fi
  http=$(opencode_curl "${probe_username}" "${probe_password}" \
    -sS -o /dev/null -w '%{http_code}' "${endpoint}" \
    --max-time 15 2>/dev/null || echo "000")

  if [[ "${http}" = "200" ]]; then
    if [[ "${consec}" -gt 0 ]]; then
      echo "[$(date '+%F %T')] [${name}] recovered after ${consec} failures (HTTP 200)" >> "${log_file}"
    fi
    echo 0 > "${state_file}"
    return 0
  fi

  consec=$((consec + 1))
  echo "${consec}" > "${state_file}"
  echo "[$(date '+%F %T')] [${name}] failed (HTTP ${http}, consec=${consec}/${THRESHOLD})" >> "${log_file}"

  if [[ "${consec}" -ge "${THRESHOLD}" ]]; then
    echo "[$(date '+%F %T')] [${name}] threshold reached, restarting opencode-${name}" >> "${log_file}"
    if "${PM2_BIN}" restart "opencode-${name}" >> "${log_file}" 2>&1; then
      echo 0 > "${state_file}"
    else
      echo "${THRESHOLD}" > "${state_file}"
      echo "[$(date '+%F %T')] [${name}] pm2 restart failed" >> "${log_file}"
      return 1
    fi
  fi
}

for cfg in "${AGENTS_DIR}"/*/instance.json; do
  [[ -f "${cfg}" ]] || continue
  name=$("${JQ_BIN}" -r '.name' "${cfg}")
  port=$("${JQ_BIN}" -r '.port' "${cfg}")
  integration_runtime=$("${JQ_BIN}" -r '.integrationRuntime // false' "${cfg}")
  if is_cursor_agent_backend && [[ "${integration_runtime}" != "true" ]]; then
    continue
  fi
  if [[ -z "${name}" || "${name}" = "null" || -z "${port}" || "${port}" = "null" ]]; then
    continue
  fi
  probe_instance "${name}" "${port}" "${integration_runtime}" || FAIL=1
done

exit "${FAIL}"
