#!/usr/bin/env bash
# 私有 OpenCode 实例冒烟：认证、固定版本、隔离配置和目录级协议。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTS_DIR="${REPO_ROOT}/runtime/agents"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-runtime-smoke.XXXXXX")"
trap 'rm -rf -- "${SMOKE_ROOT}"' EXIT

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-repo-env.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/agent-backend-mode.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/curl-basic-auth.sh"
load_repo_env "${REPO_ROOT}" >/dev/null || true

FAIL=0

mark_failure() {
  echo "❌ $*"
  FAIL=1
}

probe_instance() {
  local cfg="$1"
  local name port integration username password base directory
  local unauth_code health_json config_json event_code
  local event_headers event_body status_json session_json session_id prompt_json
  local cleanup_json dispose_json

  name=$(jq -r '.name' "${cfg}")
  port=$(jq -r '.port' "${cfg}")
  integration=$(jq -r '.integrationRuntime // false' "${cfg}")
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    mark_failure "${cfg}: invalid port"
    return
  fi
  base="http://127.0.0.1:${port}"
  directory="${SMOKE_ROOT}/instance-${port}"
  mkdir -p "${directory}"
  chmod 700 "${directory}"

  if [[ "${integration}" = "true" ]]; then
    username="${OPENCODE_INTEGRATION_SERVER_USERNAME:-opencode}"
    password="${OPENCODE_INTEGRATION_SERVER_PASSWORD:-}"
  else
    username="${OPENCODE_SERVER_USERNAME:-opencode}"
    password="${OPENCODE_SERVER_PASSWORD:-}"
  fi

  echo "==> smoke: ${name} (${base})"
  unauth_code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
    "${base}/config" 2>/dev/null || echo 000)
  if [[ "${unauth_code}" != "401" ]]; then
    mark_failure "${name}: unauthenticated /config expected 401, got ${unauth_code}"
  else
    echo "✅ ${name}: unauthenticated request rejected"
  fi

  if ! health_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 10 "${base}/global/health"); then
    mark_failure "${name}: authenticated /global/health failed"
    return
  fi
  if ! jq -e '
    .healthy == true and
    .version == "1.18.3"
  ' >/dev/null <<<"${health_json}"; then
    mark_failure "${name}: OpenCode health/version contract mismatch"
    return
  fi
  echo "✅ ${name}: OpenCode 1.18.3 health verified"

  if ! config_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 10 \
    -H "x-opencode-directory: ${directory}" \
    "${base}/config"); then
    mark_failure "${name}: directory-aware /config failed"
    return
  fi
  if [[ "${integration}" = "true" ]]; then
    if ! jq -e '
      .model == "sub2api/gpt-5.6-luna" and
      .small_model == "sub2api/gpt-5.6-luna" and
      (.provider | keys) == ["sub2api"] and
      .provider["sub2api"].npm == "@ai-sdk/openai" and
      .provider["sub2api"].name == "公司 Sub2API" and
      .provider["sub2api"].options.baseURL == "https://model-gateway.example/v1" and
      (.provider["sub2api"].options.apiKey | type) == "string" and
      (.provider["sub2api"].options.apiKey | length) > 0 and
      (.provider["sub2api"].models | keys) == ["gpt-5.6-luna"] and
      .snapshot == false and
      .autoupdate == false and
      .share == "disabled" and
      .lsp == false and
      .formatter == false and
      .permission["*"] == "deny" and
      (.plugin | length) == 0 and
      (.mcp | length) == 0 and
      (.skills.paths | length) == 0 and
      (.skills.urls | length) == 0
    ' >/dev/null <<<"${config_json}"; then
      mark_failure "${name}: integration effective config is unsafe or incompatible"
    else
      echo "✅ ${name}: integration effective config verified"
    fi
  fi

  event_headers="${directory}/global-event.headers"
  event_body="${directory}/global-event.body"
  event_code=$(opencode_curl "${username}" "${password}" \
    -sS -m 2 \
    -D "${event_headers}" \
    -o "${event_body}" \
    -w '%{http_code}' \
    -H "x-opencode-directory: ${directory}" \
    "${base}/global/event" 2>/dev/null || true)
  if [[ "${event_code}" != "200" ]] || ! tr -d '\r' < "${event_headers}" |
    grep -Eiq '^content-type:[[:space:]]*text/event-stream'; then
    mark_failure "${name}: directory-aware /global/event SSE contract failed"
  else
    echo "✅ ${name}: directory-aware SSE verified"
  fi

  if ! session_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 15 -X POST \
    -H 'Content-Type: application/json' \
    -H "x-opencode-directory: ${directory}" \
    --data '{}' "${base}/session"); then
    mark_failure "${name}: directory-aware session creation failed"
    return
  fi
  session_id=$(jq -r '.id // empty' <<<"${session_json}")
  if [[ ! "${session_id}" =~ ^ses_[A-Za-z0-9_-]{1,128}$ ]]; then
    mark_failure "${name}: invalid session id"
    return
  fi

  if [[ "${integration}" = "true" ]]; then
    if ! prompt_json=$(opencode_curl "${username}" "${password}" \
      -fsS -m 60 -X POST \
      -H 'Content-Type: application/json' \
      -H "x-opencode-directory: ${directory}" \
      --data '{"tools":{"bash":false,"read":false,"glob":false,"grep":false,"task":false,"write":false,"edit":false,"webfetch":false,"websearch":false},"parts":[{"type":"text","text":"Reply with OK only."}]}' \
      "${base}/session/${session_id}/message"); then
      mark_failure "${name}: integration model prompt failed"
    elif ! jq -e '
      .info.role == "assistant" and
      .info.error == null and
      ([.parts[]? | select(
        .type == "text" and
        (.text | type) == "string" and
        (.text | length) > 0
      )] | length) > 0
    ' >/dev/null <<<"${prompt_json}"; then
      mark_failure "${name}: integration model returned no successful text response"
    else
      echo "✅ ${name}: integration model response verified"
    fi
  fi

  if ! status_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 10 \
    -H "x-opencode-directory: ${directory}" \
    "${base}/session/status"); then
    mark_failure "${name}: directory-aware /session/status failed"
  elif ! jq -e 'type == "object"' >/dev/null <<<"${status_json}"; then
    mark_failure "${name}: /session/status returned a non-object"
  else
    echo "✅ ${name}: directory-aware session status verified"
  fi

  if ! cleanup_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 10 -X DELETE \
    -H "x-opencode-directory: ${directory}" \
    "${base}/session/${session_id}"); then
    mark_failure "${name}: smoke session cleanup request failed"
  elif ! jq -e '. == true' >/dev/null <<<"${cleanup_json}"; then
    mark_failure "${name}: smoke session cleanup was not acknowledged"
  else
    echo "✅ ${name}: authenticated session lifecycle verified"
  fi

  if ! dispose_json=$(opencode_curl "${username}" "${password}" \
    -fsS -m 10 -X POST \
    -H "x-opencode-directory: ${directory}" \
    "${base}/instance/dispose"); then
    mark_failure "${name}: directory instance disposal failed"
  elif ! jq -e '. == true' >/dev/null <<<"${dispose_json}"; then
    mark_failure "${name}: directory instance disposal was not acknowledged"
  else
    echo "✅ ${name}: directory instance disposal verified"
  fi
}

for cfg in "${AGENTS_DIR}"/*/instance.json; do
  [[ -f "${cfg}" ]] || continue
  integration=$(jq -r '.integrationRuntime // false' "${cfg}")
  if is_cursor_agent_backend && [[ "${integration}" != "true" ]]; then
    continue
  fi
  probe_instance "${cfg}"
done

if [[ "${FAIL}" -ne 0 ]]; then
  echo "❌ smoke 有失败项"
  exit 1
fi
echo "✅ smoke 全部通过"
