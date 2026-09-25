import type { JobAccepted, JobRecord, JobRequest } from './contracts.js'
import { createJob, getJob } from './store.js'
import { processJob } from './worker.js'

export function submitJob(request: JobRequest): JobAccepted {
  createJob(request.id)
  processJob(request.id, request.value)
  return { id: request.id, status: 'accepted' }
}

export function readJob(id: string): JobRecord | undefined {
  return getJob(id)
}
