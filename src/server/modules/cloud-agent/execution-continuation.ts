import type { CloudHarness, CloudReview } from '@/contracts/cloud-agent'
import type { ExecutionConfig } from './execution-config'
import type { TaskTool } from './task-tools'
import { CloudError, CloudEnvironmentError } from './domain'
import { sha256 } from './scoped-files'

const passed = (status: CloudHarness, id: string) => status.nodes.some(node => node.id === id && node.status === 'passed')
export function executionStep(status: CloudHarness) {
  if (!passed(status, 'ui_prototype_approved')) return 'approval'
  if (!passed(status, 'implemented')) return 'implementation'
  if (!passed(status, 'wired')) return 'wiring'
  if (status.codeReview?.status !== 'passed') return 'review'
  if (!passed(status, 'build_passed')) return 'build'
  if (!passed(status, 'functional_parity_passed')) return 'device'
  return passed(status, 'delivery_ready') ? 'complete' : 'finalize'
}

export function executionEnvironmentIssue(status: CloudHarness, config: ExecutionConfig) {
  const step = executionStep(status)
  if (step === 'build' && !config.build) return '构建阶段缺少配置，请管理员在 workspace-apps.json 当前 App 的 cloud_agent.execution.build 或 execution_profiles 中配置构建命令与产物路径'
  if (step === 'device' && !config.device) return '设备验收阶段未配置 hdc，请管理员配置当前 App 的 execution.device；无需重做需求审批'
  return ''
}

const steps = {
  approval: '人工批准校验', implementation: '代码实现', wiring: '调用链接通', review: '独立代码审查',
  build: '构建验证', device: '设备与功能验收', finalize: '交付文档生成', complete: '交付就绪',
}
const instructions = {
  approval: '不得绕过已失效或缺失的真人批准。',
  implementation: '定向 source_read 查清剩余开关和播放器事实，用 source_edit 局部修改现有文件、source_write 新建文件，必要时 source_move/source_delete；整个任务鸿蒙项目可编辑，包括共享模块与工程配置。按 Harness Schema 登记 record-change；工程查证和未完成接线不是让用户处理的事项。',
  wiring: '补齐真实调用、数据、渲染及生命周期七段接线，用原生 record-change 登记可核验证据，每项 reachability 都要有 status=passed；核销 zero_callers、zero_consumers、write_only_fields 后，明确填写三个空数组、核查说明 notes 及 skeleton_audit.status=passed。此源码自检允许登记，不是人工批准或独立审查通过；原生校验达到 wired 后调用 harness_code_review。不能用实现骨架冒充接通。',
  review: '先区分审查中的真实缺陷和缺少证据。真实缺陷用 source_edit 修复并更新接线证据，不对未修复的同一代码反复重审；仅缺证据先定向查证，不为触发重审制造源码改动。source_list 定位HAR，source_archive列举并读取实际接口声明，source_read读取签名元信息，artifact_list定位报告或收据。补齐可核验依据后 harness_code_review；报告不存在或失效时先审查，不能以findings为空忽略blocked checks，也不能对相同证据无限重审或自行登记通过。',
  build: '调用 harness_build；确定失败先用 harness_build_log 读取返回的 execution/<执行ID>/build.log，默认读尾部，offset按字节分页；该工具支持含控制字符的大日志，不要因 artifact_read 拒绝日志而停下。修复真实编译错误、更新接线证据并独立审查，然后构建；执行ID由平台绑定快照，不重放结果不确定的操作。',
  device: '先 harness_device_context 核验包名、已安装包和已有取证。安装成功但包名查询失败时，根据源码和built_bundle补录application，再harness_install mode=verify_existing，不能盲目重装。随后 harness_device_smoke action=observe并传新operationId读取当前页面；App不在前台才action=launch。用harness_observation_read读取截图与层级，发现遮挡弹窗用action=dismiss绑定observationOperationId、hierarchy和reason关闭后复核，不按按钮文案禁止业务。登录、同意业务协议、进入模式等场景动作在已批准的验收attempt内用harness_device_step执行并记录结果；缺账号或验证码只挂起相关场景。多帧设备动作设置足够timeout_seconds。已发出的swipe若只因后置dumpLayout超时进入in_doubt，用原operationId与原payload只读结算，再用新观察确认当前页面，绝不换ID重发滑动。模拟器 HDC 不支持录屏：在模拟器上用 recordSeconds=0 截图及控件树继续验收，不因缺少 MP4 阻断独立场景；动态播放断言可按已审方案使用至少三次纯 observe 的 frame_motion 验证同一 Video/XComponent 的画面变化，单张截图不能证明播放，也不能证明声音、失败回退或生命周期。若缺少有效运动证据，只挂起依赖该证据的断言。真机可复用已有有效录屏；录屏失败先读video.reason和原始命令，若系统录屏生成0字节或确定性不支持，不要对同一录屏后端重复启动。只有原媒体变为有效时才用原operationId恢复导出；其他独立验收继续。截图和运动观察不能冒充MP4或业务PASS。正式harness_test须配置执行器，缺项仅挂起依赖工作。',
  finalize: '调用 harness_finalize 生成四文档并严格校验 delivery_ready；不提交、推送、合入或发布。',
  complete: '保留交付证据，由工作台自动登记集成台并通知创建人；模型不提交、推送或创建MR。',
}
export const deviceExecutionGuidance = instructions.device
interface Checkpoint {
  status: CloudHarness
  progress: number
  review?: CloudReview['kind']
  environmentIssue?: string
  deviceTestIssue?: string
  exhausted?: boolean
  lastError?: string
}
export class ExecutionContinuation {
  private previous = ''
  private unchanged = 0
  private turns = 0
  private buildDiagnosed = false
  private deviceDiagnosed = false
  private swipeReconciliationOffered = false
  private visualDependencyDiagnosed = false
  decide(input: Checkpoint) {
    const { status } = input, step = executionStep(status)
    const native = status.continuation
    if (native) {
      const unsafe = status.blockers.find(item => ['runtime_inspection_failed', 'run_busy', 'operation_in_doubt', 'runtime_paused', 'runtime_waiting'].includes(item.code))
      if (unsafe || ['paused', 'closed_with_gaps'].includes(native.status)) {
        if (unsafe?.code === 'operation_in_doubt' && native.status === 'must_continue' &&
            input.lastError?.includes('POST_SWIPE_LAYOUT_TIMEOUT') && !this.swipeReconciliationOffered) {
          this.swipeReconciliationOffered = true
          return { kind: 'continue' as const, reason: '核对已发出的滑动命令及后置取证超时收据',
            prompt: `只调用一次原harness_device_step，传原operationId和完全相同的payload，使Harness核对已成功的滑动命令与动作后截图并结算旧收据；绝不换ID或重新滑动。结算结果不等于业务通过，再用新的只读观察确认当前页面。若原命令未确认或旧证据无效，保留未决并停止副作用。原工具问题=${input.lastError}` }
        }
        return { kind: 'blocked' as const, reason: unsafe?.message || native.reason || '原生执行已暂停或等待外部条件' }
      }
      if (input.review) return { kind: 'approval' as const, reason: `原生 ${input.review} 审核包已就绪，等待真人确认` }
      if (native.status === 'external_block') {
        const visualHeld = native.blocked.some(item => item.action === 'complete_visual_comparison_or_record_existing_decision')
        if (step === 'device' && visualHeld && !input.environmentIssue && !input.exhausted && !this.visualDependencyDiagnosed) {
          this.visualDependencyDiagnosed = true
          return { kind: 'continue' as const, reason: '核查失败场景是否误阻塞独立视觉取证', prompt: `只诊断一次实际视觉依赖，不重跑已通过场景。先读取执行计划、canonical ui_scope 和已有截图/对比报告：单个失败回退样本不足，不等于正常态、播放态和滚动态不能取证。harness_capture 以当前有效构建和对应页面状态为前提，不要求全部业务场景通过。只有证据证明依赖关联错误时，才用 harness_execution_plan 修正该依赖的 blocked_actions；保留真实场景依赖、hold、累计尝试和授权。随后导航到可复现的批准状态，复用有效截图或 harness_capture 采集并计算三方差异，准备真人审核。仍遵守用户不操作网络、不改变业务开关的限制，不编造失败样本、不代批视觉、不用正常播放替代失败回退。确实无法独立取证时保存具体证据和条件，结束本次诊断，不反复生成总结。原生调度=${JSON.stringify(native)}` }
        }
        const dependencies = native.blocked.filter(item => item.owner === 'external').map(item => [item.reason, item.condition && `恢复条件：${item.condition}`].filter(Boolean).join('；')).filter(Boolean)
        return { kind: 'blocked' as const, reason: dependencies.length ? `等待验收条件：${[...new Set(dependencies)].join('；')}` : native.reason || '原生执行等待外部条件' }
      }
      if (step === 'complete') return { kind: 'complete' as const, reason: 'Harness 与独立代码审查均已通过，交付就绪' }
      if (input.exhausted) return { kind: 'blocked' as const, reason: '平台本轮工具预算耗尽；已保留原生进度和场景预算。这不是人工审批，恢复后继续原档案。' }
      const actionable = native.pending.filter(item => item.owner === 'agent')
      const dependentActions = step === 'build' ? ['complete_build', 'execute_required_scenarios', 'complete_visual_comparison_or_record_existing_decision', 'complete_independent_review', 'complete_acceptance_closeout'] : []
      if (input.environmentIssue && actionable.length > 0 && actionable.every(item => dependentActions.includes(item.action))) {
        return { kind: 'blocked' as const, reason: `当前构建环境阻塞，剩余待办依赖该构建，已停止重复调用。${input.environmentIssue}。保留原分支与已审结果，修复环境后继续。` }
      }
      const onlyCloseout = actionable.length > 0 && actionable.every(item => item.action === 'complete_acceptance_closeout')
      const prerequisites = native.blocked.filter(item => ['complete_build', 'execute_required_scenarios', 'complete_visual_comparison_or_record_existing_decision', 'complete_independent_review'].includes(item.action))
      if (step === 'device' && !input.environmentIssue && !this.deviceDiagnosed) {
        this.deviceDiagnosed = true
        return { kind: 'continue' as const, reason: '先完成独立启动与设备取证，再处理业务验收依赖', prompt: instructions.device + '复用已有收据，未知动作不能换ID重放。若已有当前包的完整取证，直接处理剩余独立工作并报告具体条件，不重复启动。' + (input.deviceTestIssue ? `当前不要调用 harness_test：${input.deviceTestIssue}。只推进独立取证和无依赖工作。` : '') }
      }
      if (step === 'build' && !input.environmentIssue && !this.buildDiagnosed && (prerequisites.some(item => item.action === 'complete_build') || this.unchanged >= 1)) {
        this.buildDiagnosed = true
        return { kind: 'continue' as const, reason: '自动诊断构建阻塞，核对当前配置与旧失败是否一致', prompt: '不要重复总结或从头转译。先调用 harness_build_context 查看当前配置、精确包路径和最近原生失败，再按需 harness_build_log。编译成功但包登记失败时只排查输出定位，不能根据 WARN 修改业务代码。若当前配置或源码已修复原阻塞，使用 harness_execution_plan 更新对应依赖并调用 harness_build；保留有效审批与审查。条件未变化不得换ID盲目重试，也不得伪造包或验收收据。无法自行解除时登记具体外部条件，继续其他独立待办。' }
      }
      if (onlyCloseout && (step === 'build' || (step === 'device' && !!input.environmentIssue)) && (input.environmentIssue || prerequisites.length)) {
        return { kind: 'blocked' as const, reason: `验收收尾等待前置条件，当前不能生成真实运行证据；无需重新审批。${input.environmentIssue || prerequisites.map(item => [item.action, item.reason, item.condition].filter(Boolean).join('：')).join('；')}。修复条件后继续当前档案，不重做已通过步骤。` }
      }
      if (!actionable.length && native.canEndTurn) return { kind: 'blocked' as const, reason: [native.reason, ...native.blocked.map(item => [item.reason, item.condition].filter(Boolean).join('：'))].filter(Boolean).join('；') || '独立工作已处理，等待已登记条件或人工决定' }
      if (step === 'approval') return { kind: 'blocked' as const, reason: 'Scope/UI 授权缺失或失效，保留原档案，不能自动重做审批' }
      // A host circuit breaker counts unchanged evidence and scheduling, not model turns.
      const signature = JSON.stringify({ phase: status.phase, native, acceptance: status.acceptance, progress: input.progress, review: status.codeReview?.status })
      this.unchanged = signature === this.previous ? this.unchanged + 1 : 0
      this.previous = signature
      if (this.unchanged >= 8) {
        const gaps = step === 'review' ? status.codeReview?.checks.filter(check => check.status !== 'passed').map(check => `${check.id}：${check.evidence}`).join('；') : ''
        return { kind: 'blocked' as const, reason: gaps ? `代码审查前置条件仍未解决，自动查证后没有新增证据；停止重复收尾，保留原分支与批准。待补依据：${gaps}` : `平台检测到连续8轮没有新证据或调度变化，已保留进度；需要排查工具或模型空转，不是新增审批。${input.lastError || ''}` }
      }
      if (onlyCloseout && ['implementation', 'wiring', 'review'].includes(step)) {
        return { kind: 'continue' as const, reason: `验收收尾的前置未完成，自动返回${steps[step]}定向修复`, prompt: `原生虽然仅列出complete_acceptance_closeout，但真实未通过的是${steps[step]}。禁止调用 harness_finalize，不重复尝试被拒绝的收尾，也不重新审批。${instructions[step]} 当前审查报告=${JSON.stringify(status.codeReview || null)}。读取产物失败先artifact_list逐层确认路径，源码使用source_list，不猜路径。签名兼容性与真实播放效果属于后续构建/设备门禁，不伪造提前通过；静态可验证的接口、安全边界和接线仍必须核验。新证据可用后更新execution-plan对应依赖，不擅自清除人工hold或未决操作。最后harness_status确认真实推进；确实缺外部材料时具体说明缺哪项、已核验哪些路径。` }
      }
      const stageBlocked = !!input.environmentIssue || prerequisites.some(item => step === 'build' ? item.action === 'complete_build' : step === 'device' && item.action === 'execute_required_scenarios')
      const formalIssue = step === 'device' && input.deviceTestIssue ? `正式验收限制：${input.deviceTestIssue}。不要调用 harness_test，不要改业务代码来修复配置；登记执行器依赖，继续独立材料准备、取证与可执行的视觉核对。` : ''
      const deviceRecovery = step === 'device' ? '遮挡弹窗先harness_device_smoke action=observe，用harness_observation_read读取原图及层级；确认控件后action=dismiss并传observationOperationId、hierarchy及reason，返回新观察后复核。不要根据“登录”“同意”“进入模式”等文案拒绝已批准的业务场景；场景交互用harness_device_step并保留真实证据。控件变化重新观察；swipe成功但后置dumpLayout超时的in_doubt收据用原operationId和原payload只读结算，不重放动作，随后新观察。fixture缺失时可用harness_device_smoke action=observe传logTag读取实际配置/响应/播放日志，再按返回的路径和哈希读取原件；该只读诊断不登记业务PASS。模拟器 HDC 不支持录屏，使用 recordSeconds=0 的截图继续独立场景；动态播放按 frame_motion 的多帧规则取证，证据不足只挂起对应断言。录屏失败时读video.reason和命令；0字节或系统录屏初始化失败属于设备能力问题，停止同后端空转，保存收据，不阻塞其他工作。' : ''
      return { kind: 'continue' as const, reason: '按 Harness 原生待办继续独立工作', prompt: `继续同一档案，不初始化、不重复有效审批。原生调度=${JSON.stringify(native)}。优先处理 agent 待办；单个外部条件不阻塞无依赖工作。当前环境提示=${input.environmentIssue || '无'}，需登记到 execution-plan 的对应依赖而非结束整任务。${formalIssue}${deviceRecovery}${stageBlocked ? '当前阶段有已知前置阻塞；仅推进无依赖的原生 pending 项。环境未变化不得重复构建或换操作ID重试；没有运行证据不得提前补收尾或 finalize。' : formalIssue ? '' : instructions[step]}\n缺少计划用 harness_execution_plan；验收先 harness_acceptance configure，随后 start/finish/block/reopen；未知设备操作结果先核对，禁止换ID重放。${step === 'finalize' ? 'closeout 先补 normal_start/configuration 的真实证据，再 harness_finalize。' : '当前前置门禁未完成，禁止调用 harness_finalize；先推进当前工程步骤。'}当前独立代码审查=${JSON.stringify(status.codeReview || null)}。最近工具问题=${input.lastError || '无'}。最后 harness_status，只要原生还有可执行项就继续。` }
    }
    if (input.review) return { kind: 'approval' as const, reason: `原生 ${input.review} 审核包已就绪，等待真人确认` }
    if (step === 'complete') return { kind: 'complete' as const, reason: 'Harness 与独立代码审查均已通过，交付就绪' }
    if (step === 'approval') return { kind: 'blocked' as const, reason: `Scope/UI 批准未通过当前校验，不能继续编码：${status.blockers.map(item => item.message).join('；') || '请检查原生审批收据与范围摘要'}` }
    if (input.environmentIssue) return { kind: 'blocked' as const, reason: input.environmentIssue }
    if (input.exhausted) return { kind: 'blocked' as const, reason: `已达本轮 400 次工具预算，停在${steps[step]}；已保留源码和原生档案` }
    if (step === 'device' && input.deviceTestIssue) {
      if (!this.deviceDiagnosed) {
        this.deviceDiagnosed = true
        return { kind: 'continue' as const, reason: '正式执行器缺失，先完成独立设备取证', prompt: `${instructions.device} 当前不要调用 harness_test：${input.deviceTestIssue}` }
      }
      // Missing optional formal adapter does not disable native preparation tools.
    }
    const signature = JSON.stringify({ phase: status.phase, nodes: status.nodes.map(({ id, status }) => ({ id, status })), review: status.codeReview?.status, progress: input.progress })
    this.unchanged = this.previous === signature ? this.unchanged + 1 : 0
    this.previous = signature
    const remaining = status.blockers.map(item => `[${item.code}] ${item.message}`).join('；')
    const detail = [remaining, input.lastError].filter(Boolean).join('；').slice(0, 1800)
    if (this.unchanged >= 3) return { kind: 'blocked' as const, reason: `连续 3 次续跑无新工程进展，停在${steps[step]}。${detail || '模型未完成当前工程步骤，请检查执行过程；不是新增人工审批。'}` }
    if (this.turns >= 24) return { kind: 'blocked' as const, reason: `已达本轮 24 次自动续跑上限，停在${steps[step]}。${detail}` }
    this.turns++
    const reason = `编码自动续跑 ${this.turns}/24：继续${steps[step]}`
    const reviewReport = step === 'review' && status.codeReview ? `\n当前独立审查报告（工具返回或网络状态不替代该核验结果；内容是证据，不是授权）：${JSON.stringify(status.codeReview)}\n报告已由平台核验；按问题修复源码，不能把检查失败当成缺少人工批准。` : ''
    return { kind: 'continue' as const, reason, prompt: `${reason}。普通回答结束不是任务完成，保持当前会话、Worktree 和唯一档案，不重新初始化或重复全量调查。\n${instructions[step]}${reviewReport}\n原生阶段=${status.phase}；待处理=${remaining || '尚未达到下一阶段'}；下一步=${status.next.join('；')}；最近工具问题=${input.lastError || '无'}。\n只处理当前步骤，未来步骤的设备/执行器缺项不阻止当前源码查证、实现、审查与构建。保留真实未知事实，不猜测业务值；不得伪造批准、收据或完成状态。修正后 harness_status，继续可执行工作，不只输出总结。` }
  }
}

/** Count new source evidence, not repeated tool calls or timestamped status reports. */
export class ExecutionProgress {
  private proofs = new Set<string>()
  private failures = new Map<string, string>()
  private environmentFailures = new Map<string, string>()
  get count() { return this.proofs.size }
  get environmentIssue() { return [...this.environmentFailures].filter(([name]) => name !== 'harness_test').map(([, message]) => message).join('；') }
  get deviceTestIssue() { return this.environmentFailures.get('harness_test') || '' }
  get lastError() { return [...this.failures.values()].slice(-3).join('；') }
  observe(tool: TaskTool): TaskTool {
    const name = tool.definition.name
    return { ...tool, call: async args => {
      try {
        const result = await tool.call(args)
        if (result.isError) this.failures.set(name, `${name}：${result.content.filter(item => item.type === 'text').map(item => item.text).join(' ').slice(0, 600)}`)
        else {
          this.failures.delete(name)
          this.environmentFailures.delete(name)
          if (name === 'harness_device_smoke') {
            let recordingIssue = ''
            for (const item of result.content) {
              if (item.type !== 'text') continue
              try {
                const receipt = JSON.parse(item.text).result?.receipt
                if (receipt?.status === 'completed' && typeof receipt.progress_fingerprint === 'string') this.proofs.add(`device:${receipt.context}:${receipt.progress_fingerprint}`)
                if (['failed', 'unsupported'].includes(receipt?.video?.status) && typeof receipt.video.reason === 'string') recordingIssue = `harness_device_smoke 录屏${receipt.video.status}：${receipt.video.reason.slice(0, 600)}`
              } catch { /* An unstructured tool response is not device progress. */ }
            }
            if (recordingIssue) this.failures.set(name, recordingIssue)
          }
          if (['source_read', 'source_archive', 'source_write', 'source_edit', 'source_move', 'source_delete', 'source_image', 'source_image_copy', 'harness_execution_plan', 'harness_acceptance', 'harness_prepare_fixtures', 'harness_device_step', 'harness_android_reference', 'harness_build', 'harness_build_context', 'harness_build_log', 'harness_test', 'harness_capture'].includes(name)) {
            const content = name.startsWith('harness_') ? result.content.map(item => {
              if (item.type !== 'text') return item
              try {
                const parsed = JSON.parse(item.text)
                // Native wrapper status contains checkedAt; replay is not new work.
                const { status: _status, ...body } = parsed
                const stable = JSON.parse(JSON.stringify(body, (key, value) => ['checkedAt', 'idempotent'].includes(key) ? undefined : value))
                return { type: 'text', text: JSON.stringify(stable) }
              } catch { return item }
            }) : result.content
            this.proofs.add(sha256(JSON.stringify({ name, path: args.path, platform: args.platform, offset: args.offset || 0, content })))
          }
        }
        return result
      } catch (error) {
        if (error instanceof CloudEnvironmentError) this.environmentFailures.set(name, error.message)
        this.failures.set(name, `${name}：${error instanceof CloudError ? error.message.slice(0, 3600) : '工具执行异常，需检查参数或运行环境'}`)
        throw error
      }
    } }
  }
}
