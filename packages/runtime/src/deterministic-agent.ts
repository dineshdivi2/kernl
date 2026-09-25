import type { AgentResult, RuntimeTask } from './types.js'

const QUEUE_SOURCE = `import type { JobEvent } from './contracts.js'

type Consumer = (event: JobEvent) => void
let consumer: Consumer | undefined

export function subscribe(next: Consumer): () => void {
  consumer = next
  return () => {
    if (consumer === next) consumer = undefined
  }
}

export function enqueue(event: JobEvent): void {
  queueMicrotask(() => consumer?.(event))
}
`

const API_SOURCE = `import type { JobAccepted, JobRecord, JobRequest } from './contracts.js'
import { createJob, getJob } from './store.js'
import { enqueue } from './queue.js'
import './worker.js'

export function submitJob(request: JobRequest): JobAccepted {
  createJob(request.id)
  enqueue({ eventId: \`job-created:\${request.id}\`, jobId: request.id, value: request.value })
  return { id: request.id, status: 'accepted' }
}

export function readJob(id: string): JobRecord | undefined {
  return getJob(id)
}
`

const DEFECTIVE_WORKER_SOURCE = `import type { JobEvent } from './contracts.js'
import { subscribe } from './queue.js'
import { completeJob } from './store.js'

export function processEvent(event: JobEvent): void {
  completeJob(event.jobId, event.value.toUpperCase())
}

subscribe(processEvent)
`

const REPAIRED_WORKER_SOURCE = `import type { JobEvent } from './contracts.js'
import { subscribe } from './queue.js'
import { completeJob } from './store.js'

const processedEventIds = new Set<string>()

export function processEvent(event: JobEvent): void {
  if (processedEventIds.has(event.eventId)) return
  processedEventIds.add(event.eventId)
  completeJob(event.jobId, event.value.toUpperCase())
}

export function resetWorkerState(): void {
  processedEventIds.clear()
}

subscribe(processEvent)
`

export class DeterministicAgentAdapter {
  readonly id = 'deterministic-v1'

  async implement(task: RuntimeTask): Promise<AgentResult> {
    switch (task.kind) {
      case 'queue-contract':
        return {
          adapter: 'deterministic',
          taskId: task.id,
          summary: 'Added the in-memory versioned queue capability and delivery boundary.',
          mutations: [{ path: 'src/queue.ts', content: QUEUE_SOURCE }],
        }
      case 'api-refactor':
        return {
          adapter: 'deterministic',
          taskId: task.id,
          summary: 'Changed the API from direct worker invocation to JobEvent publication.',
          mutations: [{ path: 'src/api.ts', content: API_SOURCE }],
        }
      case 'worker-refactor':
        return {
          adapter: 'deterministic',
          taskId: task.id,
          summary: 'Changed the worker into a queue consumer; the first candidate intentionally lacks duplicate-delivery protection.',
          mutations: [{ path: 'src/worker.ts', content: DEFECTIVE_WORKER_SOURCE }],
        }
      case 'worker-repair':
        return {
          adapter: 'deterministic',
          taskId: task.id,
          summary: 'Added an event-id guard in the worker without modifying the failing test or public contract.',
          mutations: [{ path: 'src/worker.ts', content: REPAIRED_WORKER_SOURCE }],
        }
    }
  }
}
