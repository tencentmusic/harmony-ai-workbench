import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-'));
process.env.DATABASE_URL = `file:${path.join(root, 'test.db')}`;
process.env.IMAGE_COMPRESSION_DIR = path.join(root, 'images');
await fs.writeFile(path.join(root, 'test.db'), '');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
const { prisma } = await import('../src/lib/prisma.ts');
const { hashToken } = await import('../src/lib/token.ts');
const { compressionApi } = await import('../src/lib/image-compression/api.ts');
const request = (route, method = 'GET', body, token = 'image-test-a', extra = {}) => compressionApi(new Request(`http://localhost/${route}`, {
  method, headers: { authorization: `Bearer ${token}`, ...extra }, body,
}), route.split('/'));
try {
  for (const key of ['a', 'b']) await prisma.apiToken.create({ data: { id: key, personName: key, personCode: key, tokenHash: hashToken(`image-test-${key}`) } });
  assert.equal((await request('capabilities', 'GET', undefined, 'invalid')).status, 401);
  assert.equal((await (await request('capabilities')).json()).ready, true);
  assert.equal((await request('tasks', 'POST', 'abc', undefined, { 'x-file-name': '../bad.png' })).status, 400);
  assert.equal((await request('tasks', 'POST', 'abc', undefined, { 'x-file-name': 'big.png', 'content-length': '52428801' })).status, 413);
  execFileSync('python3', ['-c', 'from PIL import Image; import sys; Image.new("RGBA", (32,32), (100,20,50,0)).save(sys.argv[1])', path.join(root, 'sample.png')]);
  const response = await request('tasks', 'POST', await fs.readFile(path.join(root, 'sample.png')), undefined, { 'x-file-name': 'sample.png' });
  assert.equal(response.status, 202);
  const { item } = await response.json();
  assert.equal((await request('tasks', 'POST', 'abc', undefined, { 'x-file-name': 'busy.png' })).status, 429);
  assert.equal((await request(`tasks/${item.id}`, 'GET', undefined, 'image-test-b')).status, 404);
  assert.equal((await request(`tasks/${item.id}/png.zip`, 'GET', undefined, 'image-test-b')).status, 404);
  let task;
  for (let i = 0; i < 100; i++) {
    task = (await (await request(`tasks/${item.id}`)).json()).item;
    if (task.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task.status, 'succeeded', task.error);
  assert.equal(task.report.verifiedCount, 1);
  for (const file of ['png.zip', 'webp.zip', 'smallest.zip', 'details.csv']) {
    const download = await request(`tasks/${item.id}/${file}`);
    assert.equal(download.status, 200);
    assert.ok((await download.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await request(`tasks/${item.id}/input`)).status, 404);
  for (const extension of ['JPG', 'jpeg', 'webp']) {
    const name = `sample.${extension}`;
    execFileSync('python3', ['-c', 'from PIL import Image; import sys; Image.new("RGB", (32,32), (100,20,50)).save(sys.argv[1])', path.join(root, name)]);
    const upload = await request('tasks', 'POST', await fs.readFile(path.join(root, name)), undefined, { 'x-file-name': name });
    assert.equal(upload.status, 202);
    const id = (await upload.json()).item.id;
    for (let i = 0; i < 100; i++) {
      task = (await (await request(`tasks/${id}`)).json()).item;
      if (task.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(task.status, 'succeeded', task.error);
    assert.equal(task.report.verifiedCount, 1);
  }
  assert.equal((await request('tasks', 'POST', 'text', undefined, { 'x-file-name': 'bad.txt' })).status, 400);
  const broken = await request('tasks', 'POST', Buffer.from('bad image'), undefined, { 'x-file-name': 'bad.png' });
  const brokenId = (await broken.json()).item.id;
  for (let i = 0; i < 100; i++) {
    task = (await (await request(`tasks/${brokenId}`)).json()).item;
    if (task.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task.status, 'failed');
  assert.equal((await request(`tasks/${brokenId}/png.zip`)).status, 409);
  console.log('image-compression API: auth, owner isolation, limits, compression, downloads and failure cleanup passed');
} finally {
  await prisma.$disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
