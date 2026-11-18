#!/usr/bin/env bash
# Agent 后端固定为 OpenCode（Cursor Worker 已下线）。

normalize_harmony_agent_backend() {
  echo "opencode"
}

is_opencode_agent_backend() {
  return 0
}

is_cursor_agent_backend() {
  return 1
}
