import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildEnvironmentDiagnostic, readBuildEnvironmentDiagnostic } from './build-diagnostics'

test('native path failure is actionable, while source failures are not environment blockers', () => {
  assert.match(buildEnvironmentDiagnostic('ERROR: Failed :network:default@SignHsp. The certificate has expired! NotAfter: Sat Oct 10 09:01:30 CST 2026')!, /签名证书已过期/)
  assert.equal(buildEnvironmentDiagnostic('ERROR: certificate format is incorrect'), null)
  assert.match(buildEnvironmentDiagnostic('The maximum full path to an object file is 250 characters. ninja: error: mkdir(CMakeFiles/test.dir): No such file or directory')!, /Windows 构建路径过长/)
  assert.equal(buildEnvironmentDiagnostic('CMAKE_OBJECT_PATH_MAX warning only'), null)
  assert.match(buildEnvironmentDiagnostic('Error Message: The length of path exceeds the maximum length: 259.')!, /真实短路径工作树/)
  assert.match(buildEnvironmentDiagnostic("EINVAL: invalid argument, mkdir 'C:\\cache\\default@CompileArkTS\\esmodule\\debug\\C:'")!, /非法缓存路径/)
  assert.equal(buildEnvironmentDiagnostic('ArkTS ERROR: property missing'), null)
  assert.match(buildEnvironmentDiagnostic("Invalid value of 'DEVECO_SDK_HOME' in the system environment path")!, /SDK 路径无效/)
  assert.match(buildEnvironmentDiagnostic("ninja: error: 'C:/task/entry/oh_modules/@kuikly/render/libs/arm64-v8a/libkuikly.so', needed by 'libentry.so', missing and no known rule to make it")!, /Harmony 依赖缺失/)
  assert.equal(buildEnvironmentDiagnostic("ninja: error: 'src/code.cpp', missing and no known rule to make it"), null)
})

test('diagnostics read a bounded log tail and tolerate a missing build log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'build-diagnostic-'))
  try {
    const file = path.join(root, 'build.log')
    assert.equal(await readBuildEnvironmentDiagnostic(file), null)
    await writeFile(file, 'x'.repeat(100000) + '\nCMAKE_OBJECT_PATH_MAX: cannot be safely placed')
    assert.match((await readBuildEnvironmentDiagnostic(file))!, /路径过长/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
