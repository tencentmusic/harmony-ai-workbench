import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const root = process.cwd()
const q = path.join(root, 'data', 'repo-sync', 'queue')
const files = fs.existsSync(q) ? fs.readdirSync(q).filter((f) => f.endsWith('.json')) : []
console.log('queue_files', files.length, files.slice(0, 5))

const lockDir = path.join(root, 'data', 'repo-sync', 'locks')
const locks = fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : []
console.log('locks', locks.length, locks)

const p = new PrismaClient()
const byStatus = await p.repoSyncRun.groupBy({ by: ['status'], _count: true })
console.log('db_by_status', byStatus)

const running = await p.repoSyncRun.findMany({
  where: { status: { in: ['queued', 'running'] } },
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: { id: true, repoId: true, branch: true, trigger: true, status: true, createdAt: true },
})
console.log('pending_runs', running)
await p.$disconnect()
