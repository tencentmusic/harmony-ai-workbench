#!/usr/bin/env bash
# 从工台 config/workspace-apps.json 生成 legacy app-scopes JSON 并写入 workspace/app-scopes.json。
#
# 用法：
#   # shellcheck disable=SC1091
#   source "${SCRIPT_DIR}/write-app-scopes-json.sh"
#   write_workspace_app_scopes_json "${CWD}" "${WORKBENCH_REPO_ROOT:-}"

workbench_repo_root_for_scopes() {
  if [[ -n "${WORKBENCH_REPO_ROOT:-}" ]]; then
    echo "${WORKBENCH_REPO_ROOT}"
    return 0
  fi
  if [[ -n "${REPO_ENV:-}" && -f "${REPO_ENV}" ]]; then
    local dir
    dir="$(cd "$(dirname "${REPO_ENV}")" && pwd)"
    echo "${dir}"
    return 0
  fi
  if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    echo "${script_dir}"
    return 0
  fi
  return 1
}

read_android_app_scopes_json_raw() {
  local repo_root
  if ! repo_root="$(workbench_repo_root_for_scopes)"; then
    return 1
  fi
  local cfg="${repo_root}/config/workspace-apps.json"
  local printer="${repo_root}/scripts/print-legacy-app-scopes.mjs"
  if [[ ! -f "${cfg}" || ! -f "${printer}" ]]; then
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node 缺失，无法读取 workspace-apps.json" >&2
    return 1
  fi
  node "${printer}"
}

write_workspace_app_scopes_json() {
  local cwd="$1"
  local dst="${cwd}/app-scopes.json"
  local raw

  if ! raw="$(read_android_app_scopes_json_raw)"; then
    echo "WARN: 跳过 app-scopes.json（未找到 config/workspace-apps.json）" >&2
    return 1
  fi

  if ! echo "${raw}" | jq empty 2>/dev/null; then
    echo "ERROR: workspace-apps legacy scopes 不是合法 JSON" >&2
    return 1
  fi

  echo "${raw}" | jq '.' > "${dst}"
}
