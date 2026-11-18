import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePm2ProcessList, verifyWorker } from './verify-deployed-harness.mjs';
import { checkToolchain, toolchainPaths } from './check-cloud-agent-toolchain.mjs';

const expected = {
  CLOUD_AGENT_HARNESS_PYTHON: '/srv/workbench/.runtime/harness-venv/bin/python',
  CLOUD_AGENT_HARNESS_ROOT: '/srv/harness/android-harmony-migration-harness',
};
function processWith(env = expected, status = 'online') {
  return [{ name: 'harmony-cloud-agent-worker', pid: 123, pm2_env: { status, env } }];
}

test('accepts the online worker using the preflight environment', () => {
  assert.doesNotThrow(() => verifyWorker(processWith(), expected));
});

test('parses pm2 jlist after a daemon version notice', () => {
  const processes = processWith();
  assert.deepEqual(parsePm2ProcessList(JSON.stringify(processes)), processes);
  assert.deepEqual(parsePm2ProcessList(`\n>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\n${JSON.stringify(processes)}\n`), processes);
  assert.throws(() => parsePm2ProcessList('>>>> In-memory PM2 is out-of-date'), /JSON process list/);
});

test('rejects missing and offline workers', () => {
  assert.throws(() => verifyWorker([], expected), /not online/);
  assert.throws(() => verifyWorker(processWith(expected, 'errored'), expected), /not online/);
});

test('rejects a worker using another Python or Harness checkout', () => {
  assert.throws(() => verifyWorker(processWith({ ...expected, CLOUD_AGENT_HARNESS_PYTHON: '/usr/bin/python3' }), expected), /CLOUD_AGENT_HARNESS_PYTHON/);
  assert.throws(() => verifyWorker(processWith({ ...expected, CLOUD_AGENT_HARNESS_ROOT: '/srv/old-harness' }), expected), /CLOUD_AGENT_HARNESS_ROOT/);
});

test('checks only tools selected by the active execution profile', () => {
  const config = { projects: [{ apps: [{ status: 'active', cloud_agent: { enabled: true, execution_profiles: {
    'test-server': { build: { command: [process.execPath, import.meta.filename] }, device: { hdc: process.execPath } },
    'local-windows': { device: { hdc: '/missing/other-profile' } },
  } } }] }] };
  assert.deepEqual(toolchainPaths(config, 'test-server'), [process.execPath, import.meta.filename]);
  assert.equal(checkToolchain(config, 'test-server', process.cwd()).status, 'passed');
  assert.throws(() => checkToolchain(config, 'test-server', '/missing/sdk'), /DEVECO_SDK_HOME/);
});
