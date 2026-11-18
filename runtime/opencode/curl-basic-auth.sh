#!/usr/bin/env bash

# Passes Basic credentials through curl's stdin config so secrets never appear
# in the process argument list. Passwords are constrained to 64 hex chars by
# deploy/start; usernames use a conservative HTTP Basic-safe subset.
opencode_curl() {
  local username="$1"
  local password="$2"
  shift 2
  [[ "${username}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || return 2
  [[ "${password}" =~ ^[0-9a-fA-F]{64}$ ]] || return 2
  printf 'user = "%s:%s"\n' "${username}" "${password}" | curl --config - "$@"
}
