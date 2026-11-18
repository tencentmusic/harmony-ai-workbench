import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function prepareVideoTools(env = process.env, { platform = process.platform, spawn = spawnSync } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const runtimeEnv = {
    ...env,
    PATH: [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(platform === 'win32' ? ';' : ':'),
    HOMEBREW_NO_AUTO_UPDATE: '1',
  };
  const run = (command, args, options = {}) => spawn(command, args, { env: runtimeEnv, encoding: 'utf8', ...options });
  const locate = (name, configured) => {
    if (configured && !paths.isAbsolute(configured)) throw new Error(`${name} 必须配置为绝对路径`);
    const binary = configured || run(platform === 'win32' ? 'where' : 'which', [name]).stdout?.trim().split(/\r?\n/)[0];
    return binary && run(binary, ['-version']).status === 0 ? binary : null;
  };
  const configuredFfmpeg = env.CLOUD_AGENT_FFMPEG_BIN?.trim();
  const configuredFfprobe = env.CLOUD_AGENT_FFPROBE_BIN?.trim();
  let ffmpeg = locate('ffmpeg', configuredFfmpeg);
  let ffprobe = locate('ffprobe', configuredFfprobe);
  if (configuredFfmpeg && !ffmpeg) throw new Error(`FFmpeg 无法启动：${configuredFfmpeg}`);
  if (configuredFfprobe && !ffprobe) throw new Error(`FFprobe 无法启动：${configuredFfprobe}`);

  if ((!ffmpeg || !ffprobe) && platform === 'darwin' && run('brew', ['--version']).status === 0) {
    const install = run('brew', ['install', 'ffmpeg'], { stdio: 'inherit', encoding: undefined });
    if (install.error || install.status !== 0) throw new Error('Homebrew 安装 FFmpeg 失败');
    ffmpeg ||= locate('ffmpeg');
    ffprobe ||= locate('ffprobe');
  }
  if (!ffmpeg || !ffprobe) throw new Error('请安装 FFmpeg 和 FFprobe，或设置 CLOUD_AGENT_FFMPEG_BIN / CLOUD_AGENT_FFPROBE_BIN 绝对路径');
  return { CLOUD_AGENT_FFMPEG_BIN: ffmpeg, CLOUD_AGENT_FFPROBE_BIN: ffprobe };
}
