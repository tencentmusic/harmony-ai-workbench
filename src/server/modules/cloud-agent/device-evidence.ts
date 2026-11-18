import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { harnessEnvironment, harnessRoot, type HarnessWorkspace } from './harness'
import { CloudError, record } from './domain'
import { relativeToRoot, scopedPath, sha256 } from './scoped-files'

export async function immutableJson(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2)
  await writeFile(file, bytes, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST') throw error
    if (await readFile(file, 'utf8') !== bytes) throw new CloudError('设备验收操作 ID 已绑定其他内容；原证据保留', 409)
  })
  return { path: file, sha256: sha256(bytes) }
}
export async function checkedEvidence(workspace: HarnessWorkspace, input: unknown) {
  const ref = record(input)
  if (typeof ref.path !== 'string' || !path.isAbsolute(ref.path) || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new CloudError('缺少原始设备证据', 409)
  const file = await scopedPath(workspace.artifactRoot, await relativeToRoot(workspace.artifactRoot, ref.path), [''], false, true)
  const bytes = await readFile(file)
  if (sha256(bytes) !== ref.sha256) throw new CloudError('原始设备证据摘要已变化', 409)
  return { path: file, sha256: ref.sha256, bytes }
}
export async function validateDeviceEvidence(workspace: HarnessWorkspace, input: string, signal: AbortSignal, mode: 'case' | 'fixture' | 'sections' | 'review' = 'case') {
  const code = `import json,runpy,sys
from pathlib import Path
api=runpy.run_path(sys.argv[1]); root=Path(sys.argv[2]); m=json.loads((root/'manifest.json').read_text(encoding='utf-8')); p=json.loads((root/'parity-matrix.json').read_text(encoding='utf-8')); v=json.loads((root/'verification-report.json').read_text(encoding='utf-8')); candidate=json.loads(Path(sys.argv[3]).read_text(encoding='utf-8')); mode=sys.argv[4]
e=api['contract']('execution'); snapshot=api['repo_snapshot'](m['harmony']['root'],m['artifact_root']); issues=[]
if mode=='fixture': issues=e.fixture_readiness(candidate,m)
elif mode=='case': issues=e.validate_case(candidate,p.get('scenarios',[]),m,v['build'],snapshot,'device')
elif mode=='review': issues=e.validate_independent_review({**v,'independent_review':candidate},p,m,snapshot)
else:
 device=candidate['device']; functional=candidate['functional']; functional['device_environment_sha256']=api['canonical_sha256'](device['environment'])
 required=api['required_acceptance_ids'](p) if 'required_acceptance_ids' in api else set(a for s in p['scenarios'] for a in s['acceptance_ids'])
 issues=api['validate_device_receipt'](device,v['build'],required,snapshot,m['harmony']['root'],str(root),m['artifact_root'],m['schema_version'])[1]
 issues+=api['validate_functional_receipt'](functional,required,v['build'],device,snapshot,m['harmony']['root'],str(root),m['artifact_root'],m['schema_version'],p['scenarios'])[1]
 for c in device['cases']: issues+=e.validate_case(c,p['scenarios'],m,v['build'],snapshot,'device')
 for c in functional['cases']: issues+=e.validate_case(c,p['scenarios'],m,v['build'],snapshot,'functional')
print(json.dumps({'issues':issues,**({'functional':functional} if mode=='sections' else {})},ensure_ascii=False))`
  const result = await promisify(execFile)(process.env.CLOUD_AGENT_HARNESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', '-c', code, path.join(harnessRoot(), 'skills/android-to-harmony-feature-rollout/scripts/migration_harness.py'), workspace.runDir, input, mode],
    { signal, shell: false, windowsHide: true, timeout: 120000, env: harnessEnvironment(), maxBuffer: 2 * 1024 * 1024 })
  const value = record(JSON.parse(result.stdout))
  if (!Array.isArray(value.issues)) throw new CloudError('原生设备证据校验返回无效', 503)
  return value as { issues: unknown[]; functional?: Record<string, unknown> }
}
