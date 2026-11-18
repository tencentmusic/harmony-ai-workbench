#!/usr/bin/env bash

# Builds an OpenCode XDG profile from a single trusted config file. The whole
# profile directory is replaced so stale custom tools/plugins cannot remain
# executable after deployment.

_opencode_profile_error() {
  echo "ERROR: $*" >&2
  return 1
}

_opencode_profile_uid() {
  local target="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%u' "${target}"
  else
    stat -c '%u' "${target}"
  fi
}

_opencode_profile_mode() {
  local target="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "${target}"
  else
    stat -c '%a' "${target}"
  fi
}

_opencode_profile_assert_owned_directory() {
  local target="$1"
  local label="$2"
  if [[ -L "${target}" || ! -d "${target}" ]]; then
    _opencode_profile_error "${label} 必须是非符号链接目录：${target}"
    return 1
  fi
  local owner
  owner=$(_opencode_profile_uid "${target}") || return 1
  if [[ "${owner}" != "${UID}" ]]; then
    _opencode_profile_error "${label} 不属于当前用户：${target}"
    return 1
  fi
}

prepare_opencode_config_profile() {
  if [[ "$#" -ne 2 ]]; then
    _opencode_profile_error \
      "prepare_opencode_config_profile requires source_file and destination_dir"
    return 2
  fi

  local source_file="$1"
  local destination_dir="$2"
  if [[ -L "${source_file}" || ! -f "${source_file}" ]]; then
    _opencode_profile_error "配置源必须是非符号链接普通文件：${source_file}"
    return 1
  fi
  local source_owner
  source_owner=$(_opencode_profile_uid "${source_file}") || return 1
  if [[ "${source_owner}" != "${UID}" ]]; then
    _opencode_profile_error "配置源不属于当前用户：${source_file}"
    return 1
  fi
  if [[ "${destination_dir}" != /* || "${destination_dir}" == "/" ]]; then
    _opencode_profile_error "profile 目标必须是非根绝对路径：${destination_dir}"
    return 1
  fi

  local parent_dir
  parent_dir=$(dirname "${destination_dir}") || return 1
  mkdir -p "${parent_dir}" || return 1
  _opencode_profile_assert_owned_directory "${parent_dir}" "profile 父目录" || return 1
  local physical_parent
  physical_parent=$(cd "${parent_dir}" && pwd -P) || return 1
  if [[ "${physical_parent}" != "${parent_dir}" ]]; then
    _opencode_profile_error "profile 父目录路径包含符号链接：${parent_dir}"
    return 1
  fi
  chmod 700 "${parent_dir}" || return 1

  if [[ -L "${destination_dir}" ]]; then
    _opencode_profile_error "profile 目标不能是符号链接：${destination_dir}"
    return 1
  fi
  if [[ -e "${destination_dir}" ]]; then
    _opencode_profile_assert_owned_directory "${destination_dir}" "现有 profile" || return 1
    local destination_mode
    destination_mode=$(_opencode_profile_mode "${destination_dir}") || return 1
    if [[ "${destination_mode}" != "700" ]]; then
      _opencode_profile_error \
        "现有 profile 权限必须是 0700（实际 ${destination_mode}）：${destination_dir}"
      return 1
    fi
  fi

  local temporary_dir
  temporary_dir=$(mktemp -d "${parent_dir}/.opencode-profile.XXXXXX") || return 1
  if ! chmod 700 "${temporary_dir}" ||
    ! cp "${source_file}" "${temporary_dir}/opencode.json" ||
    ! chmod 600 "${temporary_dir}/opencode.json"; then
    rm -rf -- "${temporary_dir}"
    return 1
  fi

  local quarantine_dir=""
  if [[ -e "${destination_dir}" ]]; then
    quarantine_dir="${destination_dir}.quarantine.$(date +%s).$$.${RANDOM}"
    if [[ -e "${quarantine_dir}" || -L "${quarantine_dir}" ]]; then
      rm -rf -- "${temporary_dir}"
      _opencode_profile_error "profile 隔离路径已存在：${quarantine_dir}"
      return 1
    fi
    if ! mv "${destination_dir}" "${quarantine_dir}"; then
      rm -rf -- "${temporary_dir}"
      return 1
    fi
  fi

  if ! mv "${temporary_dir}" "${destination_dir}"; then
    rm -rf -- "${temporary_dir}"
    if [[ -n "${quarantine_dir}" && ! -e "${destination_dir}" ]]; then
      mv "${quarantine_dir}" "${destination_dir}" || true
    fi
    return 1
  fi

  _opencode_profile_assert_owned_directory "${destination_dir}" "新 profile" || return 1
  local installed_mode installed_file_mode installed_file_owner
  installed_mode=$(_opencode_profile_mode "${destination_dir}") || return 1
  installed_file_mode=$(_opencode_profile_mode "${destination_dir}/opencode.json") || return 1
  installed_file_owner=$(_opencode_profile_uid "${destination_dir}/opencode.json") || return 1
  if [[
    "${installed_mode}" != "700" ||
    "${installed_file_mode}" != "600" ||
    "${installed_file_owner}" != "${UID}"
  ]]; then
    _opencode_profile_error "新 profile owner/mode 校验失败：${destination_dir}"
    return 1
  fi
}
