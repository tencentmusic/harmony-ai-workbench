/** Confirm PM2 started the cloud Agent with the Python validated before deploy. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFile } from './load-env-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, '.runtime', 'deploy-preflight.json');
const env = loadEnvFile(path.join(root, '.env.production'));

export function verifyWorker(processes, expected) {
  const worker = processes.find((item) => item.name === 'harmony-cloud-agent-worker');
  if (!worker || worker.pm2_env?.status !== 'online' || !worker.pid) throw new Error('harmony-cloud-agent-worker is not online');
  const actual = worker.pm2_env.env || worker.pm2_env;
  for (const name of ['CLOUD_AGENT_HARNESS_PYTHON', 'CLOUD_AGENT_HARNESS_ROOT']) {
    if (name === 'CLOUD_AGENT_HARNESS_ROOT' && !expected[name]) continue;
    if (path.resolve(actual[name] || '') !== path.resolve(expected[name] || '')) {
      throw new Error(`harmony-cloud-agent-worker ${name} differs from deployment preflight`);
    }
  }
}

export function parsePm2ProcessList(output) {
  const start = output.search(/(?:^|\n)\s*\[/);
  if (start < 0) throw new Error('pm2 jlist did not return a JSON process list');
  const processes = JSON.parse(output.slice(start).trim());
  if (!Array.isArray(processes)) throw new Error('pm2 jlist did not return a JSON process list');
  return processes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  try {
    const result = spawnSync(process.env.HARMONY_PM2_BIN || 'pm2', ['jlist'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) throw new Error(`pm2 jlist failed: ${result.stderr || result.error?.message || result.status}`);
    verifyWorker(parsePm2ProcessList(result.stdout), env);
    report.worker = 'passed';
    report.status = 'passed';
    console.log('[deploy] 云 Agent Worker 已使用预检的 Harness Python');
  } catch (error) {
    report.status = 'failed';
    report.worker = 'failed';
    report.error = error.message;
    console.error(`[deploy] ${error.message}`);
    process.exitCode = 1;
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
