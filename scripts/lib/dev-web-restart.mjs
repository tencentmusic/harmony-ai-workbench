export function createDevWebRestart(restart, notify = console.error) {
  let stopped = false
  let timer
  let attempts = []
  return {
    handleExit(service) {
      if (service.name !== 'dev') return false
      if (stopped || timer) return true
      attempts = attempts.filter(time => Date.now() - time < 60_000)
      if (attempts.length >= 3) {
        notify('[dev:stack] 网页服务连续退出，停止自动重启；后台任务保持运行。修正网页启动错误后可单独运行 npm run dev。')
        return true
      }
      attempts.push(Date.now())
      notify('[dev:stack] 网页服务已退出，稍后仅重启网页；后台任务保持运行。')
      timer = setTimeout(() => {
        timer = undefined
        if (!stopped) restart(service)
      }, 500)
      return true
    },
    stop() { stopped = true; clearTimeout(timer); timer = undefined },
  }
}
