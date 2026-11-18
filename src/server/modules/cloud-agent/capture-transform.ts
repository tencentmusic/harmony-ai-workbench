import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { CloudError, record } from './domain'

export async function prepareCaptureTransform(directory: string, input: unknown) {
  if (input !== undefined) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 4) throw new CloudError('截图转换需要 1 到 4 个 crop/resize 操作')
    for (const item of input) {
      const operation = record(item)
      const keys = operation.op === 'crop' ? ['op', 'x', 'y', 'width', 'height'] : ['op', 'width', 'height', 'resample']
      const validSize = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      if (!['crop', 'resize'].includes(String(operation.op)) || Object.keys(operation).length !== keys.length || keys.some(key => !Object.hasOwn(operation, key)) ||
        !validSize(operation.width) || !validSize(operation.height) || Number(operation.width) * Number(operation.height) > 40_000_000 ||
        (operation.op === 'resize' && !['nearest', 'bilinear', 'bicubic', 'lanczos'].includes(String(operation.resample))) ||
        (operation.op === 'crop' && [operation.x, operation.y].some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) {
        throw new CloudError('截图转换参数非法；只支持显式矩形裁剪和有界尺寸缩放')
      }
    }
  }
  const file = path.join(directory, 'capture-transform.json'), contents = JSON.stringify(input ?? null)
  await writeFile(file, contents, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST') throw error
    if (await readFile(file, 'utf8') !== contents) throw new CloudError('截图操作已绑定其他转换，请核对原结果后使用新操作 ID', 409)
  })
  return input === undefined ? [] : ['--capture-transform', file]
}
