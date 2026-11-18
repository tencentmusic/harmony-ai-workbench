import { CloudError, record } from './domain'

export interface DeviceBinding { assertionId: string; where: Record<string, string | boolean>; field: string }
export interface DeviceStep { kind: string; text?: string; points?: number[] }
export interface DevicePlan { version: 1; scenarioId: string; accountOrRoom: string; actions: { id: string; steps: DeviceStep[]; bindings: DeviceBinding[] }[] }
const fail = (message: string): never => { throw new CloudError(`设备验收方案：${message}`, 409) }
function keys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some(key => !allowed.includes(key))) fail('包含不支持字段；不能提交观察值或通过结论')
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\x00-\x1f]/.test(value)) return fail('文字字段非法')
  return value
}
export function scenarioRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return fail('缺少 canonical 清单')
  return value.map(record)
}
export function selectorParts(value: unknown): string[] {
  const parts = text(value).split('.')
  if (parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) fail('观察 selector 非法')
  return parts
}
export function parseDevicePlan(value: unknown, scenario: Record<string, unknown>): DevicePlan {
  const raw = record(value)
  keys(raw, ['version', 'scenarioId', 'accountOrRoom', 'actions'])
  if (raw.version !== 1 || raw.scenarioId !== scenario.id || scenario.required_execution_kind !== 'device_observed') fail('场景身份或执行类型不匹配')
  const actions = scenarioRows(scenario.actions), assertions = scenarioRows(scenario.assertions)
  const inputs = scenarioRows(raw.actions)
  if (inputs.length !== actions.length || inputs.length > 30) fail('必须覆盖全部 canonical 动作')
  const result = inputs.map((input, index) => {
    keys(input, ['id', 'steps', 'bindings'])
    const action = actions[index]
    if (input.id !== action.id) fail('动作 ID 或顺序不匹配')
    if (!['tap', 'swipe', 'navigate', 'wait', 'observe', 'launch', 'back', 'home'].includes(String(action.kind))) fail(`动作 ${String(action.id)} (${String(action.kind)}) 不受内置观察/导航执行器支持；保留未测，不改变网络或配置`)
    const steps = scenarioRows(input.steps).map(step => {
      keys(step, ['kind', 'text', 'points'])
      if (!['observe', 'text_tap', 'wait_for_text', 'swipe', 'back', 'home', 'launch'].includes(String(step.kind))) fail('只支持原生观察与导航，不支持任意 shell、坐标点击或设置修改')
      const kind = String(step.kind)
      if (['text_tap', 'wait_for_text'].includes(kind)) {
        if (step.points !== undefined) fail('文字动作不能含坐标')
        return { kind, text: text(step.text) }
      }
      if (step.text !== undefined) fail('非文字动作不能含 text')
      if (kind === 'swipe') {
        if (!Array.isArray(step.points) || step.points.length !== 4 || !step.points.every(n => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 10000)) fail('滑动坐标非法')
        return { kind, points: step.points as number[] }
      }
      if (step.points !== undefined) fail('动作不接受坐标')
      return { kind }
    })
    if (!steps.length || steps.length > 12) fail('每动作需 1..12 个有界设备步骤')
    // An observation alone cannot stand in for an approved interaction.
    const kinds = steps.map(step => step.kind)
    if (action.kind === 'tap' && !kinds.includes('text_tap') || action.kind === 'swipe' && !kinds.includes('swipe') || action.kind === 'navigate' && !kinds.some(kind => ['text_tap', 'home', 'back', 'launch'].includes(kind))) fail('步骤未执行 canonical 动作')
    if (['home', 'back', 'launch'].includes(String(action.kind)) && !kinds.includes(String(action.kind))) fail('步骤未执行 canonical 生命周期动作')
    const required = assertions.filter(assertion => assertion.action_id === input.id)
    const bindings = scenarioRows(input.bindings).map(binding => {
      keys(binding, ['assertionId', 'where', 'field'])
      const assertion = required.find(row => row.id === binding.assertionId)
      if (!assertion) return fail('断言不属于本动作')
      if (assertion.observation_kind !== 'ui_snapshot') fail('断言不是 UI 观察')
      selectorParts(assertion.selector)
      const where = record(binding.where)
      const attributes = ['id', 'text', 'type', 'description', 'selected', 'hierarchy']
      keys(where, attributes)
      if (!Object.keys(where).length || Object.values(where).some(value => typeof value !== 'string' && typeof value !== 'boolean')) fail('控件匹配需至少一个实际属性')
      const field = text(binding.field)
      if (![...attributes, 'bounds', 'enabled', 'clickable', 'frame_motion'].includes(field)) fail('只能读取真实控件属性或连续视频画面')
      if (field === 'frame_motion' && (!['XComponent', 'Video'].includes(String(where.type)) || steps.length < 3 || steps.some(step => step.kind !== 'observe'))) fail('frame_motion 需精确匹配 Video/XComponent 并使用至少三个纯观察步骤')
      return { assertionId: text(binding.assertionId), where: where as DeviceBinding['where'], field }
    })
    if (bindings.length !== required.length || new Set(bindings.map(binding => binding.assertionId)).size !== required.length) fail('断言遗漏或重复')
    return { id: text(input.id), steps, bindings }
  })
  return { version: 1, scenarioId: text(raw.scenarioId), accountOrRoom: text(raw.accountOrRoom), actions: result }
}
export function extractNodeValue(nodes: Record<string, unknown>[], binding: DeviceBinding, bundle: string) {
  const matches = nodes.filter(node => node.bundleName === bundle && [true, 'true'].includes(node.visible as boolean | string) && Object.entries(binding.where).every(([key, value]) => String(node[key]) === String(value)))
  if (matches.length > 1) fail(`断言 ${binding.assertionId} 匹配多个控件，需更精确定位`)
  const value = matches[0]?.[binding.field]
  if (value !== undefined && typeof value !== 'string' && typeof value !== 'boolean') fail('观察属性不是可支持的标量')
  return value
}
export function bindObservation(data: Record<string, unknown>, selector: unknown, value: unknown) {
  const parts = selectorParts(selector)
  let current = data
  for (const key of parts.slice(0, -1)) {
    if (current[key] === undefined) current[key] = {}
    current = record(current[key])
  }
  if (Object.hasOwn(current, parts.at(-1)!)) fail('观察 selector 重叠')
  if (value !== undefined) current[parts.at(-1)!] = value
}
