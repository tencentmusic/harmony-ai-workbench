/** Validate executables selected by the active cloud Agent execution profile. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function toolchainPaths(config, profile) {
  const paths = new Set();
  for (const project of config.projects || []) {
    for (const app of project.apps || []) {
      if (app.status !== 'active' || app.cloud_agent?.enabled !== true) continue;
      const execution = app.cloud_agent.execution_profiles?.[profile];
      if (!execution) continue;
      for (const item of execution.build?.command?.slice(0, 2) || []) paths.add(item);
      if (execution.device?.hdc) paths.add(execution.device.hdc);
    }
  }
  return [...paths];
}

export function checkToolchain(config, profile, sdkRoot) {
  const paths = toolchainPaths(config, profile);
  if (!paths.length) return { profile, tools: 0, status: 'not_configured' };
  if (!sdkRoot || !path.isAbsolute(sdkRoot) || !fs.existsSync(sdkRoot) || !fs.statSync(sdkRoot).isDirectory()) {
    throw new Error(`DEVECO_SDK_HOME is missing or invalid for profile ${profile}`);
  }
  for (const tool of paths) {
    if (!path.isAbsolute(tool) || !fs.existsSync(tool) || !fs.statSync(tool).isFile()) {
      throw new Error(`Cloud Agent tool missing for profile ${profile}: ${tool}`);
    }
  }
  return { profile, tools: paths.length, status: 'passed' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'workspace-apps.json'), 'utf8'));
    const profile = process.env.WORKSPACE_PROFILE || config.runtime.default_profile;
    console.log(JSON.stringify(checkToolchain(config, profile, process.env.DEVECO_SDK_HOME)));
  } catch (error) {
    console.error(`[deploy] ${error.message}`);
    process.exitCode = 1;
  }
}
