import { completeJob } from './store.js'

export function processJob(jobId: string, value: string): void {
  completeJob(jobId, value.toUpperCase())
}
