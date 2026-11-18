#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+$/
const DATE = /^\d{4}\.\d{2}\.\d{2}$/

export function checkReleaseNotes({ changelog, packageVersion }) {
  if (!changelog || typeof changelog !== 'object' || Array.isArray(changelog)) {
    throw new Error('config/changelog.json 必须是对象')
  }
  const releases = changelog.releases
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('config/changelog.json releases 不能为空')
  }

  const latestIndexes = []
  for (const [index, release] of releases.entries()) {
    if (!release || typeof release !== 'object') {
      throw new Error(`releases[${index}] 必须是对象`)
    }
    if (!SEMVER.test(String(release.version || ''))) {
      throw new Error(`releases[${index}].version 必须是 x.y.z`)
    }
    if (!DATE.test(String(release.date || ''))) {
      throw new Error('date 必须是 YYYY.MM.DD')
    }
    if (!Array.isArray(release.items) || release.items.length === 0) {
      throw new Error('items 不能为空')
    }
    for (const [itemIndex, item] of release.items.entries()) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`releases[${index}].items[${itemIndex}] 必须是非空字符串`)
      }
    }
    if (release.latest === true) latestIndexes.push(index)
  }

  if (latestIndexes.length !== 1) {
    throw new Error('只能有一条 latest: true')
  }
  if (latestIndexes[0] !== 0) {
    throw new Error('latest: true 必须是 releases[0]')
  }

  const latestVersion = releases[0].version
  if (String(packageVersion || '') !== latestVersion) {
    throw new Error(
      `package.json version ${packageVersion} 必须等于 changelog 最新版本 ${latestVersion}`,
    )
  }
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(path.resolve(entry)).href === import.meta.url
}

if (isMain()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const changelog = JSON.parse(
    readFileSync(path.join(repoRoot, 'config', 'changelog.json'), 'utf8'),
  )
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  checkReleaseNotes({ changelog, packageVersion: pkg.version })
  console.log(
    `check-changelog: ok (${pkg.version} = changelog latest ${changelog.releases[0].version})`,
  )
}
