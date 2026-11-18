#!/usr/bin/env bash
# 与 deploy-background.mjs 对齐的 env 加载顺序。
#
# 用法：
#   # shellcheck disable=SC1091
#   source "${SCRIPT_DIR}/load-repo-env.sh"
#   load_repo_env "${REPO_ROOT}"
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
