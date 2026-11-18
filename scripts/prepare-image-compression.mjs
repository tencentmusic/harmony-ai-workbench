/** Prepare the image codec runtime as part of deployment, before stopping the service. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvFile } from './load-env-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.production');
const env = { ...process.env, ...loadEnvFile(envPath) };
env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);
function available(command, args) {
  return spawnSync(command, args, { env, stdio: 'ignore' }).status === 0;
}
function run(command, args) {
  const result = spawnSync(command, args, { env, cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`图片压缩运行环境准备失败：${command}`);
}
function locate(command) {
  const result = spawnSync('which', [command], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`找不到压缩工具：${command}`);
  return result.stdout.trim().split('\n')[0];
}
const oxipng = env.IMAGE_OXIPNG || 'oxipng';
const cwebp = env.IMAGE_CWEBP || 'cwebp';
const jpegtran = env.IMAGE_JPEGTRAN || 'jpegtran';
if (!available(oxipng, ['--version']) || !available(cwebp, ['-version']) || !available(jpegtran, ['-version'])) {
  if (process.platform !== 'darwin' || !available('brew', ['--version'])) {
    throw new Error('请预装 oxipng、cwebp、jpegtran，并配置 IMAGE_OXIPNG / IMAGE_CWEBP / IMAGE_JPEGTRAN 后重新部署');
  }
  env.HOMEBREW_NO_AUTO_UPDATE = '1';
  const formulas = [];
  if (!available(oxipng, ['--version'])) formulas.push('oxipng');
  if (!available(cwebp, ['-version'])) formulas.push('webp');
  if (!available(jpegtran, ['-version'])) formulas.push('jpeg-turbo');
  run('brew', ['install', ...formulas]);
}
// Some macOS WebP bottles require libtiff even when Homebrew's dependency
// metadata omits it. Verify the loader output instead of trusting file presence.
const webpProbe = spawnSync(cwebp, ['-version'], { env, encoding: 'utf8' });
if (process.platform === 'darwin' && /\/(?:opt\/homebrew|usr\/local)\/opt\/libtiff\//.test(webpProbe.stderr || '')) {
  run('brew', ['install', 'libtiff']);
}
if (!available(oxipng, ['--version']) || !available(cwebp, ['-version']) || !available(jpegtran, ['-version'])) {
  throw new Error('图片编码器无法启动，请检查系统动态库；保留当前服务');
}
const managedPython = path.join(root, '.runtime', 'image-compression-venv', 'bin', 'python3');
let python = env.IMAGE_COMPRESSION_PYTHON || (fs.existsSync(managedPython) ? managedPython : 'python3');
if (!available(python, ['-c', 'from PIL import Image'])) {
  if (env.IMAGE_COMPRESSION_PYTHON) throw new Error('IMAGE_COMPRESSION_PYTHON 指定的 Python 缺少 Pillow，请修正配置后部署');
  run('python3', ['-m', 'venv', path.dirname(path.dirname(managedPython))]);
  python = managedPython;
  run(python, ['-m', 'pip', 'install', 'Pillow>=10.4,<13']);
}
const imagePython = path.isAbsolute(python) ? python : locate(python);
const configured = {
  IMAGE_COMPRESSION_PYTHON: imagePython,
  IMAGE_OXIPNG: path.isAbsolute(oxipng) ? oxipng : locate(oxipng),
  IMAGE_CWEBP: path.isAbsolute(cwebp) ? cwebp : locate(cwebp),
  IMAGE_JPEGTRAN: path.isAbsolute(jpegtran) ? jpegtran : locate(jpegtran),
};
Object.assign(env, configured);
run(python, ['server/image-compression/worker.py', '--self-test']);
let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const previous = content;
for (const [key, value] of Object.entries(configured)) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
}
if (content !== previous) {
  const temporary = `${envPath}.image-runtime.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, envPath);
}
console.log('[image-compression] 运行环境就绪');
