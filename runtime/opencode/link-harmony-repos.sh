#!/usr/bin/env bash
# 为 workspace-apps 中配置了 harmony 仓的 App 创建 workspace symlink。
#
# 用法（需先 source write-app-scopes-json.sh）：
#   link_harmony_app_repos "${OPENCODE_AGENT_CWD}"
link_harmony_app_repos() {
  local cwd="$1"
  local scopes_raw=""
  [[ -n "${cwd}" ]] || return 0
  if ! command -v jq >/dev/null 2>&1; then
    echo "    WARN: jq 缺失，跳过鸿蒙仓库 symlink"
    return 0
  fi

  # shellcheck disable=SC1091
  if declare -F read_android_app_scopes_json_raw >/dev/null 2>&1; then
    scopes_raw="$(read_android_app_scopes_json_raw 2>/dev/null || true)"
  fi
  [[ -n "${scopes_raw}" ]] || return 0

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    local repo_root="${line%%|*}"
    local alias="${line#*|}"
    if [[ -z "${repo_root}" ]]; then
      echo "    WARN: 项目包未解析鸿蒙路径，跳过 ${alias} symlink"
      continue
    fi
    if [[ ! -d "${repo_root}" ]]; then
      echo "    WARN: ${repo_root} 不存在，跳过 ${alias} symlink"
      continue
    fi
    ln -sfn "${repo_root}" "${cwd}/${alias}"
    echo "    ✓ ${cwd}/${alias} → ${repo_root}"
  done < <(
    echo "${scopes_raw}" | jq -r '
      .[]
      | select(.harmonyRepoRoot != null and .harmonyRepoRoot != "")
      | "\(.harmonyRepoRoot)|\(.harmonyWorkspaceAlias // "harmony-src")"
    ' | sort -u
  )
}
