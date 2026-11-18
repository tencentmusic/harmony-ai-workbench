#!/usr/bin/env bash
# 一键部署 kb-mcp-for-zc（驻场 HTTP MCP Gateway）
#
# 用法：
#   bash packages/kb-mcp-gateway/deploy.sh           # 实际部署
#   bash packages/kb-mcp-gateway/deploy.sh --check   # dry-run
#
# 行为：
#   1. npm install @ KB 根目录（SDK / MCP 依赖）
#   2. 确保 packages/kb-mcp-gateway/.env.production
#   3. pm2 startOrReload ecosystem.config.cjs + pm2 save
#   4. GET /health 探活
#   5. 注册 healthcheck cron（*/5min，断电/重启后 pm2 resurrect 失败兜底）
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
KB_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKBENCH_ROOT="$(cd "${KB_ROOT}/../.." && pwd)"
INSTALL_ROOT="${KB_ROOT}"
if [[ -f "${WORKBENCH_ROOT}/package.json" ]] && grep -q '"name": "kg-harmony-ai-workbench"' "${WORKBENCH_ROOT}/package.json"; then
  INSTALL_ROOT="${WORKBENCH_ROOT}"
fi
ECOSYSTEM_FILE="${SCRIPT_DIR}/ecosystem.config.cjs"
HEALTHCHECK_SCRIPT="${SCRIPT_DIR}/healthcheck.sh"
ENV_PROD="${SCRIPT_DIR}/.env.production"
ENV_EXAMPLE="${SCRIPT_DIR}/.env.production.example"

: "${NODE_BIN_DIR:=${HOME}/.local/node/bin}"
export PATH="${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

step() { echo; echo "==> $*"; }
plan() {
  if ${DRY_RUN}; then echo "    [DRY-RUN] $*"; else echo "    $*"; fi
}
do_cmd() {
  if ${DRY_RUN}; then echo "    [DRY-RUN] would run: $*"; else eval "$@"; fi
}
die() { echo "ERROR: $*" >&2; exit 1; }

step "1. KB 依赖（android-harmony-kb @ ${KB_ROOT}）"
if [[ ! -f "${KB_ROOT}/package.json" ]]; then
  die "KB 根目录无效: ${KB_ROOT}"
fi
plan "npm install @ ${INSTALL_ROOT}"
do_cmd "cd '${INSTALL_ROOT}' && npm install"

step "2. Gateway 环境"
if [[ ! -f "${ENV_PROD}" ]]; then
  if [[ -f "${ENV_EXAMPLE}" ]]; then
    plan "cp ${ENV_EXAMPLE} → .env.production"
    do_cmd "cp '${ENV_EXAMPLE}' '${ENV_PROD}'"
  else
    die "缺少 ${ENV_PROD} 与 ${ENV_EXAMPLE}"
  fi
else
  echo "    ✓ ${ENV_PROD} 已存在"
fi

step "3. pm2 startOrReload kb-mcp-for-zc"
if ! command -v pm2 >/dev/null 2>&1; then
  die "pm2 不在 PATH 中（请安装 Node.js + pm2）"
fi
PNAME="kb-mcp-for-zc"
EXPECTED_SCRIPT="${SCRIPT_DIR}/scripts/run-gateway.mjs"
if pm2 describe "${PNAME}" >/dev/null 2>&1; then
  OLD_SCRIPT=$(pm2 jlist 2>/dev/null | sed '/^>>>>/d;/^In memory PM2/d;/^Local PM2/d' | jq -r --arg n "${PNAME}" '.[] | select(.name==$n) | .pm2_env.pm_exec_path // empty' 2>/dev/null || true)
  if [[ -n "${OLD_SCRIPT}" && "${OLD_SCRIPT}" != "${EXPECTED_SCRIPT}" ]]; then
    plan "旧 pm2 配置 (${OLD_SCRIPT}) 与 ecosystem 不一致，pm2 delete ${PNAME}"
    do_cmd "pm2 delete '${PNAME}'"
  elif [[ -n "${OLD_SCRIPT}" && ! -f "${OLD_SCRIPT}" ]]; then
    plan "旧 script 已不存在，pm2 delete ${PNAME}"
    do_cmd "pm2 delete '${PNAME}'"
  fi
fi
plan "pm2 startOrReload ${ECOSYSTEM_FILE}"
do_cmd "pm2 startOrReload '${ECOSYSTEM_FILE}' --update-env"
do_cmd "pm2 save"
echo "    ✓ pm2 startOrReload + save 完成"

step "4. 健康检查"
PORT=$(grep -E '^KB_MCP_PORT=' "${ENV_PROD}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || echo "8420")
HOST=$(grep -E '^KB_MCP_HOST=' "${ENV_PROD}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || echo "127.0.0.1")
URL="http://${HOST}:${PORT}/health"
ALL_HEALTHY=true
if ${DRY_RUN}; then
  plan "curl ${URL}"
else
  sleep 1
  CODE="000"
  for _ in 1 2 3 4 5; do
    CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || echo "000")
    [[ "${CODE}" == "200" ]] && break
    sleep 2
  done
  if [[ "${CODE}" == "200" ]]; then
    echo "    ✅ kb-mcp-for-zc (${URL}): HTTP ${CODE}"
  else
    echo "    ❌ kb-mcp-for-zc (${URL}): HTTP ${CODE}"
    ALL_HEALTHY=false
  fi
fi

step "5. 注册 healthcheck cron (*/5min)"
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
  echo "✓ DRY-RUN 完成"
elif ${ALL_HEALTHY}; then
  echo "✅ kb-mcp-for-zc 部署完成"
  echo "   探活：curl ${URL}"
  echo "   日志：pm2 logs kb-mcp-for-zc"
  echo "   断电自启：请一次性执行 pm2 save && pm2 startup（若尚未配置）"
else
  echo "⚠️  部署完成但健康检查失败，请 pm2 logs kb-mcp-for-zc 排查"
  exit 1
fi
