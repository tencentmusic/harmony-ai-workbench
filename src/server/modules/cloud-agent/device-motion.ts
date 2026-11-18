import sharp from 'sharp'
import { CloudError } from './domain'
import { extractNodeValue, type DeviceBinding } from './device-plan'

export interface MotionSample { at: number; nodes: Record<string, unknown>[]; image: Buffer }

// This proves changing pixels inside a stationary video surface, not audio or failure recovery.
export async function observeSurfaceMotion(samples: MotionSample[], binding: DeviceBinding, bundle: string) {
  if (samples.length < 3 || !['XComponent', 'Video'].includes(String(binding.where.type))) throw new CloudError('动态画面需至少三次真实 Video/XComponent 观察', 409)
  let bounds = '', dimensions = ''
  const frames: Buffer[] = []
  for (const [index, sample] of samples.entries()) {
    if (index && sample.at - samples[index - 1].at < 0.5) throw new CloudError('动态画面采样间隔不足 500ms', 409)
    const current = extractNodeValue(sample.nodes, { ...binding, field: 'bounds' }, bundle)
    if (typeof current !== 'string' || index && current !== bounds) throw new CloudError('视频控件缺失或位置变化，不能据此证明封面正在播放', 409)
    bounds = current
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds)
    if (!match) throw new CloudError('视频控件边界格式无效', 409)
    const [left, top, right, bottom] = match.slice(1).map(Number)
    const info = await sharp(sample.image, { limitInputPixels: 24_000_000 }).metadata()
    const size = `${info.width}x${info.height}`
    if (index && size !== dimensions || !info.width || !info.height || right > info.width || bottom > info.height || right - left < 80 || bottom - top < 80) throw new CloudError('视频控件不完整或截图尺寸变化', 409)
    dimensions = size
    // Ignore surface edges where host labels and decorations may overlap.
    const marginX = Math.floor((right - left) * 0.2), marginY = Math.floor((bottom - top) * 0.2)
    frames.push(await sharp(sample.image).extract({ left: left + marginX, top: top + marginY, width: right - left - 2 * marginX, height: bottom - top - 2 * marginY }).resize(96, 96).greyscale().raw().toBuffer())
  }
  const ratios = frames.slice(1).map((frame, index) => {
    let changed = 0
    for (let i = 0; i < frame.length; i++) if (Math.abs(frame[i] - frames[index][i]) >= 12) changed++
    return changed / frame.length
  })
  return { value: ratios.filter(value => value >= 0.02).length >= 2 ? 'observed_surface_motion' : undefined,
    evidence: { kind: 'stationary_video_surface_motion', bounds, dimensions, sampleTimes: samples.map(sample => sample.at), changedPixelRatios: ratios, minimumChangedRatio: 0.02, minimumPixelDelta: 12 } }
}
