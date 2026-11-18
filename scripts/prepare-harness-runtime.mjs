/** Prepare and validate the Python used by the cloud Agent before service restart. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFile } from './load-env-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.production');
const env = { ...process.env, ...loadEnvFile(envPath) };
const harnessRoot = path.resolve(root, env.CLOUD_AGENT_HARNESS_ROOT || '../androidtoharmonyharness/android-harmony-migration-harness');
const reportPath = path.join(root, '.runtime', 'deploy-preflight.json');
const managedPython = path.join(root, '.runtime', 'harness-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const legacyPython = path.join(root, '.runtime', 'image-compression-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const report = {
  ...(fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {}),
  checked_at: new Date().toISOString(), status: 'failed', harness_root: harnessRoot,
};

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 4_000_000, ...options });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()
      .replace(/https?:\/\/\S+/g, '[package URL]');
    throw new Error(`${bin} ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function saveReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}
function gitCommit(directory) {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

try {
  for (const relative of ['START_HERE.md', 'requirements.txt', 'scripts/doctor.py', '.codex-plugin/plugin.json']) {
    if (!fs.statSync(path.join(harnessRoot, relative)).isFile()) throw new Error(`Harness file missing: ${relative}`);
  }
  const configured = env.CLOUD_AGENT_HARNESS_PYTHON;
  const external = configured && path.resolve(configured) !== path.resolve(managedPython) && path.resolve(configured) !== path.resolve(legacyPython);
  const python = external ? configured : managedPython;
  if (!external) {
    if (!fs.existsSync(managedPython)) command('python3', ['-m', 'venv', path.dirname(path.dirname(managedPython))]);
    command(python, ['-c', 'import sys; assert (3, 9) <= sys.version_info[:2] < (3, 13), "Harness requires Python 3.9-3.12"']);
    command(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', path.join(harnessRoot, 'requirements.txt')]);
  }
  command(python, ['-m', 'pip', 'check']);
  const checked = JSON.parse(command(python, [path.join(root, 'scripts', 'check-harness-runtime.py'), harnessRoot]));
  report.workbench_commit = gitCommit(root);
  report.harness_commit = gitCommit(harnessRoot);
  report.workbench_lock_sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  Object.assign(report, checked, { status: 'preflight_passed', pip_check: 'passed' });
  const absolutePython = checked.python;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `CLOUD_AGENT_HARNESS_PYTHON=${JSON.stringify(absolutePython)}`;
  content = /^CLOUD_AGENT_HARNESS_PYTHON=.*$/m.test(content)
    ? content.replace(/^CLOUD_AGENT_HARNESS_PYTHON=.*$/m, line)
    : `${content.trimEnd()}\n${line}\n`;
  if (content !== (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '')) {
    const temporary = `${envPath}.harness-runtime.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, envPath);
  }
  saveReport();
  console.log(`[harness-runtime] ${report.harness_version} ready: ${absolutePython}`);
} catch (error) {
  report.error = error.message;
  saveReport();
  console.error(`[harness-runtime] ${error.message}`);
  process.exitCode = 1;
}
