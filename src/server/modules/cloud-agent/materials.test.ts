import assert from 'node:assert/strict'
import { test } from 'node:test'
import { materialFormat, parseMaterialEdit } from './material-domain'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import sharp from 'sharp'
import { prepareMaterial } from './material-processing'

test('materials have bounded formats and reject unsafe names', () => {
  assert.equal(materialFormat('需求.docx').kind, 'document')
  assert.equal(materialFormat('录屏.MP4').kind, 'video')
  assert.equal(materialFormat('设计.png').kind, 'image')
  for (const name of ['../a.png', 'a\\b.png', 'a.svg', 'a.html', 'a.exe', 'a\n.png']) assert.throws(() => materialFormat(name))
})
test('material edits bind their own version and unique attachment IDs', () => {
  assert.deepEqual(parseMaterialEdit({ material: '', materialVersion: 2, attachmentIds: ['a'] }), { material: '', materialVersion: 2, attachmentIds: ['a'], reanalyze: false })
  assert.equal(parseMaterialEdit({ material: 'changed', materialVersion: 2, reanalyze: true }).reanalyze, true)
  assert.throws(() => parseMaterialEdit({ material: 'changed', materialVersion: 2, reanalyze: 'true' }), /参数/)
  for (const value of [{ material: '', materialVersion: 1, attachmentIds: [] }, { material: 'text', materialVersion: 0 }, { material: '', materialVersion: 1, attachmentIds: ['a', 'a'] }]) assert.throws(() => parseMaterialEdit(value))
})

test('real document/image/video processing preserves evidence and enforces budgets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-material-processing-'))
  const source = path.join(directory, 'original')
  const signal = new AbortController().signal
  try {
    await writeFile(source, 'x'.repeat(60001))
    const text = await prepareMaterial(directory, 'requirements.txt', signal)
    assert.equal(text.text.length, 60000)
    assert.equal(text.warnings.length, 1)
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Profile business evidence</w:t></w:r></w:p></w:body></w:document>')
    await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
    assert.match((await prepareMaterial(directory, 'requirements.docx', signal)).text, /Profile business evidence/)
    zip.file('bomb.bin', Buffer.alloc(21 * 1024 * 1024))
    await writeFile(source, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    await assert.rejects(prepareMaterial(directory, 'bomb.docx', signal), /20 MiB/)
    await writeFile(source, await sharp({ create: { width: 2000, height: 800, channels: 3, background: '#32a1ba' } }).png().toBuffer())
    const image = await prepareMaterial(directory, 'screen.png', signal)
    assert.equal(image.files[0].mime, 'image/jpeg')
    assert.equal((await sharp(await readFile(path.join(directory, 'image.jpg'))).metadata()).width, 1600)
    await assert.rejects(prepareMaterial(directory, 'fake.jpg', signal), /扩展名/)
    execFileSync(process.env.CLOUD_AGENT_FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=2', '-t', '2', '-pix_fmt', 'yuv420p', '-f', 'mp4', '-y', source], { windowsHide: true, timeout: 30000 })
    const video = await prepareMaterial(directory, 'flow.mp4', signal)
    assert.equal(video.files.length, 0)
    assert.equal(video.video?.duration, 2)
    assert.match(video.text, /未转写音频/)
    const canceled = new AbortController(); canceled.abort()
    await assert.rejects(prepareMaterial(directory, 'flow.mp4', canceled.signal))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
