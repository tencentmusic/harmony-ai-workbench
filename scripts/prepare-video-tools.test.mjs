import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { prepareVideoTools } from './prepare-video-tools.mjs';

const require = createRequire(import.meta.url);

function fakeSpawn({ installed = false, brew = true, installStatus = 0 } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, ...args]);
    assert.match(options.env.PATH, /\/opt\/homebrew\/bin/);
    if (command === 'which') return { status: installed ? 0 : 1, stdout: installed ? `/opt/homebrew/bin/${args[0]}\n` : '' };
    if (command === 'brew' && args[0] === '--version') return { status: brew ? 0 : 1 };
    if (command === 'brew' && args[0] === 'install') {
      if (installStatus === 0) installed = true;
      return { status: installStatus };
    }
    if (command.startsWith('/opt/homebrew/bin/')) return { status: installed ? 0 : 1 };
    return { status: 1 };
  };
  return { spawn, calls };
}

test('prepares both video tools before deployment when Homebrew is available', () => {
  const fake = fakeSpawn();
  const tools = prepareVideoTools({ PATH: '/usr/bin' }, { platform: 'darwin', spawn: fake.spawn });
  assert.deepEqual(tools, {
    CLOUD_AGENT_FFMPEG_BIN: '/opt/homebrew/bin/ffmpeg',
    CLOUD_AGENT_FFPROBE_BIN: '/opt/homebrew/bin/ffprobe',
  });
  assert.equal(fake.calls.filter(call => call[0] === 'brew' && call[1] === 'install').length, 1);
});

test('reuses working binaries without installing', () => {
  const fake = fakeSpawn({ installed: true });
  prepareVideoTools({ PATH: '/usr/bin' }, { platform: 'darwin', spawn: fake.spawn });
  assert.equal(fake.calls.some(call => call[0] === 'brew'), false);
});

test('fails deployment before restart when video tools cannot be prepared', () => {
  const fake = fakeSpawn({ brew: false });
  assert.throws(() => prepareVideoTools({ PATH: '/usr/bin' }, { platform: 'darwin', spawn: fake.spawn }), /请安装 FFmpeg 和 FFprobe/);
});

test('reports a failed Homebrew install before deployment continues', () => {
  const fake = fakeSpawn({ installStatus: 1 });
  assert.throws(() => prepareVideoTools({ PATH: '/usr/bin' }, { platform: 'darwin', spawn: fake.spawn }), /Homebrew 安装 FFmpeg 失败/);
});

test('rejects an invalid explicit binary instead of replacing the operator setting', () => {
  const fake = fakeSpawn({ installed: true });
  assert.throws(() => prepareVideoTools({ PATH: '/usr/bin', CLOUD_AGENT_FFMPEG_BIN: '/bad/ffmpeg' },
    { platform: 'darwin', spawn: fake.spawn }), /FFmpeg 无法启动/);
  assert.equal(fake.calls.some(call => call[0] === 'brew'), false);
});

test('keeps valid configured paths and passes them to every PM2 process', () => {
  const fake = fakeSpawn({ installed: true });
  const tools = prepareVideoTools({
    PATH: '/usr/bin',
    CLOUD_AGENT_FFMPEG_BIN: '/opt/homebrew/bin/ffmpeg',
    CLOUD_AGENT_FFPROBE_BIN: '/opt/homebrew/bin/ffprobe',
  }, { platform: 'darwin', spawn: fake.spawn });
  assert.equal(fake.calls.some(call => call[0] === 'which' || call[0] === 'brew'), false);
  const previous = Object.fromEntries(Object.keys(tools).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, tools);
    const config = require('./ecosystem.config.cjs');
    for (const app of config.apps) {
      assert.equal(app.env.CLOUD_AGENT_FFMPEG_BIN, tools.CLOUD_AGENT_FFMPEG_BIN);
      assert.equal(app.env.CLOUD_AGENT_FFPROBE_BIN, tools.CLOUD_AGENT_FFPROBE_BIN);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
