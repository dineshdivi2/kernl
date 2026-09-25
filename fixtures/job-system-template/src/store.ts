import type { JobRecord } from './contracts.js'

const jobs = new Map<string, JobRecord>()
const processingCounts = new Map<string, number>()

export function createJob(id: string): void {
  jobs.set(id, { id, status: 'pending' })
}

export function completeJob(id: string, result: string): void {
  const count = processingCounts.get(id) ?? 0
  processingCounts.set(id, count + 1)
  jobs.set(id, { id, status: 'completed', result })
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id)
}

export function getProcessingCount(id: string): number {
  return processingCounts.get(id) ?? 0
}

export function resetStore(): void {
  jobs.clear()
  processingCounts.clear()
}
