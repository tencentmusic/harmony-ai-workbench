import fs from 'fs'
import path from 'path'

export function listSpoolFiles(spoolDir) {
  if (!fs.existsSync(spoolDir)) return []
  return fs
    .readdirSync(spoolDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(spoolDir, f))
    .sort()
}

export function readSpoolFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line))
}

export function writeSpoolFile(spoolDir, events) {
  fs.mkdirSync(spoolDir, { recursive: true })
  const file = path.join(spoolDir, `spool-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`)
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  return file
}

export function removeSpoolFile(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // ignore
  }
}
