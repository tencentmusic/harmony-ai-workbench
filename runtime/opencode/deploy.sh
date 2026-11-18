#!/usr/bin/env bash
# 一键部署普通聊天与集成工作台的 OpenCode 运行时。
#
# 用法：
#   bash runtime/opencode/deploy.sh           # 实际部署
#   bash runtime/opencode/deploy.sh --check   # dry-run
#
# 行为：
#   1. 原子写入仓库私有 XDG profile（不写 ~/.config/opencode/）
#   2. 扫描 runtime/agents/*/instance.json
#   3. 按 workspace-apps.json 项目包准备 workspace
#   4. 部署 AGENTS.md + 实例 opencode.json 到 cwd
#   5. pm2 reload ecosystem.config.cjs
#   6. 健康检查 + 注册 healthcheck cron
set -euo pipefail

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_DIR="${REPO_ROOT}/runtime/agents"
GLOBAL_CFG_SRC="${SCRIPT_DIR}/opencode.global.json"
INTEGRATION_CFG_SRC="${SCRIPT_DIR}/opencode.integration.json"
GLOBAL_CFG_DIR="${REPO_ROOT}/.runtime/opencode-xdg/opencode"
GLOBAL_CFG_DST="${GLOBAL_CFG_DIR}/opencode.json"
INTEGRATION_CFG_DIR="${REPO_ROOT}/.runtime/opencode-integration-xdg/opencode"
INTEGRATION_CFG_DST="${INTEGRATION_CFG_DIR}/opencode.json"
ECOSYSTEM_FILE="${SCRIPT_DIR}/ecosystem.config.cjs"
HEALTHCHECK_SCRIPT="${SCRIPT_DIR}/healthcheck.sh"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-repo-env.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/agent-backend-mode.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/curl-basic-auth.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/prepare-config-profile.sh"
: "${NODE_BIN_DIR:=${HOME}/.local/node/bin}"
export PATH="${NODE_BIN_DIR}:${PATH:-/usr/bin:/bin}"

step() { echo; echo "==> $*"; }
plan() {
  if ${DRY_RUN}; then
    echo "    [DRY-RUN] $*"
  else
    echo "    $*"
  fi
}
do_cmd() {
  if ${DRY_RUN}; then
    echo "    [DRY-RUN] would run: $*"
  else
    eval "$@"
  fi
}
die() { echo "ERROR: $*" >&2; exit 1; }

validate_secret() {
  local variable_name="$1"
  local value="${!variable_name:-}"
  if [[ ${#value} -lt 32 || "${value}" == replace-with-* ]]; then
    if ${DRY_RUN}; then
      echo "    WARN: ${variable_name} 缺失或少于 32 字符（实际部署会拒绝）"
    else
      die "${variable_name} 必须配置且不少于 32 字符"
    fi
  fi
}

validate_server_password() {
  local variable_name="$1"
  local value="${!variable_name:-}"
  if [[ ! "${value}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    if ${DRY_RUN}; then
      echo "    WARN: ${variable_name} 必须是 openssl rand -hex 32 生成的 64 位十六进制值"
    else
      die "${variable_name} 必须是 64 位随机十六进制值"
    fi
  fi
}

validate_server_username() {
  local variable_name="$1"
  local value="${!variable_name:-opencode}"
  [[ "${value}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "${variable_name} 格式非法"
}

validate_distinct_opencode_endpoints() {
  local chat_url="${OPENCODE_BASE_URL:-}"
  local integration_url="${OPENCODE_INTEGRATION_BASE_URL:-}"
  chat_url="${chat_url%/}"
  integration_url="${integration_url%/}"
  [[ -n "${chat_url}" ]] || die "OPENCODE_BASE_URL 缺失"
  [[ -n "${integration_url}" ]] || die "OPENCODE_INTEGRATION_BASE_URL 缺失"
  [[ "${chat_url}" != "${integration_url}" ]] || \
    die "集成工作台必须使用独立 OpenCode 实例，不能复用 OPENCODE_BASE_URL"
}

ensure_kb_mcp_deps() {
  local kb_root="${WORKSPACE_KB_ROOT:-}"
  if [[ -z "${kb_root}" || ! -f "${kb_root}/package.json" ]]; then
    echo "    WARN: workspace-apps.json 中的 KB 路径无效，跳过 KB MCP 依赖安装"
    return 0
  fi
  if [[ -d "${REPO_ROOT}/node_modules/@modelcontextprotocol/sdk" || -d "${kb_root}/node_modules/@modelcontextprotocol/sdk" ]]; then
    echo "    ✓ android-harmony-kb MCP 依赖已就绪"
    return 0
  fi
  plan "npm install @ ${REPO_ROOT}（workspace android-harmony-kb MCP 依赖）"
  do_cmd "npm install --prefix '${REPO_ROOT}' --omit=dev"
}

prepare_config_profile() {
  local source_file="$1"
  local destination_dir="$2"
  local destination_file="${destination_dir}/opencode.json"
  if ${DRY_RUN}; then
    plan "whole-directory atomic profile ${source_file} → ${destination_file}"
    return
  fi
  prepare_opencode_config_profile "${source_file}" "${destination_dir}" ||
    die "无法安全部署 OpenCode profile：${destination_dir}"
}

expand_cwd() {
  local raw="$1"
  echo "${raw}" | envsubst 2>/dev/null || echo "${raw//\$\{HOME\}/${HOME}}"
}

step "1. 校验依赖"
if load_repo_env "${REPO_ROOT}"; then
  echo "    env: ${REPO_ENV}"
else
  echo "    WARN: 未找到 .env.production / .env.local / .env"
fi
WORKSPACE_KB_ROOT="$(node "${REPO_ROOT}/scripts/print-workspace-path.mjs" knowledge-base android-harmony-kb)"
export WORKSPACE_KB_ROOT
validate_distinct_opencode_endpoints
validate_server_password OPENCODE_INTEGRATION_SERVER_PASSWORD
validate_server_username OPENCODE_INTEGRATION_SERVER_USERNAME
validate_secret SUB2API_API_KEY
REQUIRED_ALWAYS=(jq git curl rg)
REQUIRED_RUNTIME=(pm2 opencode)
for cmd in "${REQUIRED_ALWAYS[@]}"; do
  command -v "${cmd}" >/dev/null || die "${cmd} 不在 PATH（${PATH}），无法继续"
done
for cmd in "${REQUIRED_RUNTIME[@]}"; do
  if ! command -v "${cmd}" >/dev/null; then
    if ${DRY_RUN}; then
      echo "    WARN: ${cmd} 不在 PATH（dry-run 容忍；实际部署需要）"
    else
      die "${cmd} 不在 PATH（${PATH}），无法继续"
    fi
  fi
done
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_VERSION=$(opencode --version 2>/dev/null | head -n 1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' || true)
  [[ -n "${OPENCODE_VERSION}" ]] || die "无法解析 opencode --version"
  [[ "${OPENCODE_VERSION}" = "1.18.3" ]] || \
    die "OpenCode ${OPENCODE_VERSION} 未经集成协议验收，当前固定版本为 1.18.3"
  echo "    ✓ OpenCode ${OPENCODE_VERSION} 兼容"
fi
echo "    ✓ 依赖检查通过"

validate_server_password OPENCODE_SERVER_PASSWORD
validate_server_username OPENCODE_SERVER_USERNAME

step "2. 原子部署 OpenCode 隔离 profile"
prepare_config_profile "${GLOBAL_CFG_SRC}" "${GLOBAL_CFG_DIR}"
prepare_config_profile "${INTEGRATION_CFG_SRC}" "${INTEGRATION_CFG_DIR}"

step "3. 扫描 ${AGENTS_DIR}/*/instance.json"
INSTANCE_CFGS=()
for cfg in "${AGENTS_DIR}"/*/instance.json; do
  [[ -f "${cfg}" ]] || continue
  INSTANCE_CFGS+=("${cfg}")
done
if [[ ${#INSTANCE_CFGS[@]} -eq 0 ]]; then
  die "未发现任何 instance.json 在 ${AGENTS_DIR}/*/"
fi
echo "    发现 ${#INSTANCE_CFGS[@]} 个实例"

PORT_MAP=$(mktemp)
trap 'rm -f "${PORT_MAP}"' EXIT
for cfg in "${INSTANCE_CFGS[@]}"; do
  DIR_NAME=$(basename "$(dirname "${cfg}")")
  NAME=$(jq -r '.name' "${cfg}")
  IS_INTEGRATION=$(jq -r '.integrationRuntime // false' "${cfg}")
  PORT=$(jq -r '.port' "${cfg}")
  CWD_RAW=$(jq -r '.cwd' "${cfg}")
  HOST=$(jq -r '.host // "127.0.0.1"' "${cfg}")
  [[ "${NAME}" = "${DIR_NAME}" ]] || die "${cfg}: name='${NAME}' 与目录名 '${DIR_NAME}' 不一致"
  [[ "${PORT}" =~ ^[0-9]+$ ]] || die "${cfg}: port 不是数字"
  [[ "${PORT}" -ge 4000 && "${PORT}" -le 9999 ]] || die "${cfg}: port ${PORT} 越界（4000-9999）"
  [[ "${HOST}" = "127.0.0.1" ]] || die "${cfg}: host 必须是 127.0.0.1"
  [[ "${CWD_RAW}" != "null" && -n "${CWD_RAW}" ]] || die "${cfg}: cwd 缺失"
  EXISTING=$(grep "^${PORT} " "${PORT_MAP}" 2>/dev/null || true)
  [[ -z "${EXISTING}" ]] || die "port ${PORT} 被 ${NAME} 和 ${EXISTING#* } 同时使用"
  echo "${PORT} ${NAME}" >> "${PORT_MAP}"
  echo "    ✓ ${NAME}: port ${PORT}, cwd ${CWD_RAW}"
done

step "4. 准备 workspace + 部署 AGENTS.md / opencode.json"
ensure_kb_mcp_deps
for cfg in "${INSTANCE_CFGS[@]}"; do
  AGENT_DIR=$(dirname "${cfg}")
  NAME=$(jq -r '.name' "${cfg}")
  IS_INTEGRATION=$(jq -r '.integrationRuntime // false' "${cfg}")
  CWD_RAW=$(jq -r '.cwd' "${cfg}")
  CWD=$(expand_cwd "${CWD_RAW}")

  echo "  -- ${NAME} (cwd=${CWD})"
  plan "mkdir -p ${CWD}"
  do_cmd "mkdir -p '${CWD}'"

  if [[ "${IS_INTEGRATION}" = "true" ]]; then
    if ! ${DRY_RUN}; then
      [[ -d "${CWD}" && ! -L "${CWD}" ]] || die "integration CWD 必须是非符号链接目录：${CWD}"
      chmod 700 "${CWD}"
      if [[ -e "${CWD}/.env.local" ]]; then
        mv "${CWD}/.env.local" "${CWD}/.env.local.quarantine.$(date +%s).$$"
      fi
    fi
  else
    plan "prepare OpenCode workspace from config/workspace-apps.json"
    if ! ${DRY_RUN}; then
      node "${REPO_ROOT}/scripts/prepare-opencode-workspace.mjs" "${CWD}"
    fi
  fi

  if [[ -f "${AGENT_DIR}/AGENTS.md" ]]; then
    plan "cp ${AGENT_DIR}/AGENTS.md → ${CWD}/AGENTS.md"
    do_cmd "cp '${AGENT_DIR}/AGENTS.md' '${CWD}/AGENTS.md'"
  else
    echo "    WARN: ${AGENT_DIR}/AGENTS.md 不存在，跳过"
  fi

  INSTANCE_CFG_OUT="${CWD}/opencode.json"
  plan "render ${INSTANCE_CFG_OUT}"
  if ! ${DRY_RUN}; then
    if [[ "${NAME}" == "harmony" ]]; then
      node "${REPO_ROOT}/scripts/render-opencode-config.mjs" "${INSTANCE_CFG_OUT}"
    else
      jq -n --argjson src "$(cat "${cfg}")" '
        {
          "$schema": "https://opencode.ai/config.json"
        }
        + ( if $src.permissionExtras then { permission: $src.permissionExtras } else {} end )
        + ( if $src.mcp then { mcp: $src.mcp } else {} end )
      ' > "${INSTANCE_CFG_OUT}"
    fi
  fi
done

step "5. pm2 reload/start ${ECOSYSTEM_FILE}"
for cfg in "${INSTANCE_CFGS[@]}"; do
  NAME=$(jq -r '.name' "${cfg}")
  PNAME="opencode-${NAME}"
  if pm2 describe "${PNAME}" >/dev/null 2>&1; then
    OLD_SCRIPT=$(pm2 jlist 2>/dev/null | sed '/^>>>>/d;/^In memory PM2/d;/^Local PM2/d' | jq -r --arg n "${PNAME}" '.[] | select(.name==$n) | .pm2_env.pm_exec_path // empty')
    if [[ -n "${OLD_SCRIPT}" && ! -f "${OLD_SCRIPT}" ]]; then
      echo "    ${PNAME} 旧 script 已不存在，先 pm2 delete"
      do_cmd "pm2 delete '${PNAME}'"
    fi
  fi
done

plan "pm2 startOrReload ${ECOSYSTEM_FILE}"
if ! ${DRY_RUN}; then
  pm2 startOrReload "${ECOSYSTEM_FILE}"
  pm2 save
  echo "    ✓ pm2 startOrReload + save 完成"
fi

step "6. 健康检查"
ALL_HEALTHY=true
sleep 3
for cfg in "${INSTANCE_CFGS[@]}"; do
  NAME=$(jq -r '.name' "${cfg}")
  PORT=$(jq -r '.port' "${cfg}")
  IS_INTEGRATION=$(jq -r '.integrationRuntime // false' "${cfg}")
  URL="http://127.0.0.1:${PORT}/config"
  if ${DRY_RUN}; then
    echo "    [DRY-RUN] would curl ${URL}"
    continue
  fi
  if [[ "${IS_INTEGRATION}" = "true" ]]; then
    PROBE_USERNAME="${OPENCODE_INTEGRATION_SERVER_USERNAME:-opencode}"
    PROBE_PASSWORD="${OPENCODE_INTEGRATION_SERVER_PASSWORD}"
  else
    PROBE_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
    PROBE_PASSWORD="${OPENCODE_SERVER_PASSWORD}"
  fi
  CODE=000
  for _ in 1 2 3 4 5; do
    CODE=$(opencode_curl "${PROBE_USERNAME}" "${PROBE_PASSWORD}" \
      -sS -m 3 -o /dev/null -w "%{http_code}" "${URL}" 2>/dev/null || echo "000")
    [[ "${CODE}" = "200" ]] && break
    sleep 2
  done
  if [[ "${CODE}" = "200" ]]; then
    echo "    ✅ ${NAME} (port ${PORT}): HTTP ${CODE}"
  else
    echo "    ❌ ${NAME} (port ${PORT}): HTTP ${CODE}"
    ALL_HEALTHY=false
  fi
done

step "7. 注册 healthcheck cron (*/5min)"
CRON_PATH="${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CRON_LINE="*/5 * * * * PATH=${CRON_PATH} PM2_BIN=${NODE_BIN_DIR}/pm2 /bin/bash ${HEALTHCHECK_SCRIPT}"
plan "install healthcheck cron: ${CRON_LINE}"
if ! ${DRY_RUN}; then
  CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)
  FILTERED_CRONTAB=$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -Fv "${HEALTHCHECK_SCRIPT}" || true)
  {
    [[ -z "${FILTERED_CRONTAB}" ]] || printf '%s\n' "${FILTERED_CRONTAB}"
    printf '%s\n' "${CRON_LINE}"
  } | crontab -
  echo "    ✓ healthcheck cron 已幂等更新"
fi

echo
if ${DRY_RUN}; then
  echo "✓ DRY-RUN 完成（无文件被修改）"
elif ${ALL_HEALTHY}; then
  echo "✅ 部署完成，opencode-harmony 健康"
  echo "   配置隔离：${GLOBAL_CFG_DST}"
  echo "   验收：bash runtime/opencode/smoke.sh"
  step "8. reload harmony-workbench（使 OPENCODE_MODEL 与 /config 同步）"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 startOrReload "${REPO_ROOT}/scripts/ecosystem.config.cjs" --update-env 2>/dev/null || true
    pm2 save 2>/dev/null || true
    echo "    ✓ harmony-workbench 已 reload"
  else
    echo "    ⚠ pm2 不可用，请手动 reload harmony-workbench"
  fi
else
  echo "⚠️  部署完成，但健康检查失败，请 pm2 logs opencode-harmony 排查"
  exit 1
fi
