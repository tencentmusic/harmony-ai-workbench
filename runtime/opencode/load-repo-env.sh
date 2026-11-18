#!/usr/bin/env bash
# 与工台 Next.js 部署（scripts/deploy-background.mjs）对齐的 env 加载顺序。
#
# 用法（在 REPO_ROOT 已确定后）：
#   # shellcheck disable=SC1091
#   source "${SCRIPT_DIR}/load-repo-env.sh"
#   load_repo_env "${REPO_ROOT}"
#
# 优先级：
#   1. .env.production  — 测试服 / 生产部署（deploy-background.mjs 同款）
#   2. .env.local       — 本机 next dev
#   3. .env             — fallback
#
# 成功时 export REPO_ENV 为实际加载的文件路径。
load_repo_env() {
  local repo_root="$1"
  REPO_ENV=""
  local candidate
  for candidate in \
    "${repo_root}/.env.production" \
    "${repo_root}/.env.local" \
    "${repo_root}/.env"
  do
    if [[ -f "${candidate}" ]]; then
      REPO_ENV="${candidate}"
      set -a
      # shellcheck disable=SC1090
      source "${REPO_ENV}"
      set +a
      return 0
    fi
  done
  return 1
}
