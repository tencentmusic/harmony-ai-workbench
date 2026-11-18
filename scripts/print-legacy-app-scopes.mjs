#!/usr/bin/env node
/** 输出 legacy app-scopes JSON 数组（供 bash jq / app-scopes.json 使用） */
import { loadWorkspaceAppsConfig, toLegacyScopeRows } from './lib/workspace-apps.mjs'

const config = loadWorkspaceAppsConfig()
process.stdout.write(`${JSON.stringify(toLegacyScopeRows(config))}\n`)
