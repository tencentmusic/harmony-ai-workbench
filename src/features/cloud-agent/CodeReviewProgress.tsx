"use client";

import { useEffect, useState } from 'react'
import { Tag } from 'antd'
import type { CloudCodeReview, CloudRun } from '@/contracts/cloud-agent'
import { reviewDuration, reviewProgress } from './review-progress'

export function CodeReviewProgress({ report, run, executing, stale }: { report: CloudCodeReview; run?: CloudRun; executing: boolean; stale: boolean }) {
  const [now, setNow] = useState<number | null>(null)
  const progress = reviewProgress(report, run, executing, now ?? (Date.parse(report.startedAt || '') || 0))
  useEffect(() => {
    setNow(Date.now())
    if (!progress.ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [progress.ticking, report.startedAt, report.completedAt])
  return <><h3>独立代码审查 <Tag color={report.status === 'passed' && !stale ? 'green' : 'orange'}>{stale && report.status !== 'running' ? '上一版本结果 · 当前待复核' : progress.label}</Tag></h3>
    {report.round ? <p aria-label="审查耗时">本批次第 {report.round} 轮 · {progress.roundMs !== undefined ? <>本轮 {reviewDuration(progress.roundMs)} · </> : null}累计审查 {reviewDuration(progress.totalMs)}{progress.repairMs !== undefined ? <> · 修复 {reviewDuration(progress.repairMs)}</> : null} · {report.status === 'running' ? '上轮遗留' : '剩余'} {report.findings.filter(item => item.severity !== 'P3').length} 项阻断问题</p> : null}
  </>
}
