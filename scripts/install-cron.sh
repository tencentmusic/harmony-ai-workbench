#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTHCHECK_SCRIPT="${ROOT_DIR}/scripts/healthcheck.sh"
CRON_LINE="*/10 * * * * /bin/bash ${HEALTHCHECK_SCRIPT}"
TMP_FILE="$(mktemp)"

trap 'rm -f "$TMP_FILE" "${TMP_FILE}.filtered"' EXIT

crontab -l 2>/dev/null >"$TMP_FILE" || true

# 幂等升级：移除旧间隔（如 */5）的同一 healthcheck 条目后再写入 */10
if [[ -s "$TMP_FILE" ]]; then
  grep -Fv "${HEALTHCHECK_SCRIPT}" "$TMP_FILE" >"${TMP_FILE}.filtered" || true
  mv "${TMP_FILE}.filtered" "$TMP_FILE"
fi

if grep -Fqx "$CRON_LINE" "$TMP_FILE"; then
  echo "Cron entry already exists"
  exit 0
fi

if [[ -s "$TMP_FILE" ]]; then
  printf '\n' >>"$TMP_FILE"
fi
printf '%s\n' "$CRON_LINE" >>"$TMP_FILE"

crontab "$TMP_FILE"
echo "Installed cron entry: $CRON_LINE"
