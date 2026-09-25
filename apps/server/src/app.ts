import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Hono, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import { TaskClaimAuthorityError, TaskClaimInputError } from '@kernl/core'
import { KernlDemoCoordinator } from '@kernl/runtime'
import { registerV2Routes } from './v2.js'

const approvalSchema = z.object({
  runId: z.string().min(1),
  actor: z.string().min(1).max(128),
  role: z.literal('architect'),
}).strict()

const replaySchema = z.object({ runId: z.string().min(1).optional() }).strict()

const authorityString = z.string().trim().min(1).max(256)
const dshClaimTaskSchema = z.object({
  runId: authorityString,
  taskId: authorityString,
  workerId: authorityString,
  capabilities: z.array(authorityString).min(1).max(32),
  writeScopes: z.array(authorityString).min(1).max(32),
}).strict()

const dshRecordResultSchema = z.object({
  runId: authorityString,
  taskId: authorityString,
  workerId: authorityString,
  result: z.object({
    status: z.enum(['completed', 'succeeded', 'failed']),
  }).passthrough(),
}).strict()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function persistedApprovalRole(state: Record<string, unknown>, approval: Record<string, unknown>): string | undefined {
  if (typeof approval.requiredRole === 'string' && approval.requiredRole.trim()) return approval.requiredRole
  const events = Array.isArray(state.events) ? state.events.map(record).filter((event): event is Record<string, unknown> => Boolean(event)) : []
  const gateId = typeof approval.gateId === 'string' ? approval.gateId : undefined

  const architecture = [...events].reverse().find(event => event.type === 'ARCHITECTURE_CHANGE_ACCEPTED')
  const after = record(record(architecture?.payload)?.after)
  const approvalGates = Array.isArray(after?.approvalGates)
    ? after.approvalGates.map(record).filter((gate): gate is Record<string, unknown> => Boolean(gate))
    : []
  const airGate = approvalGates.find(gate => gate.id === gateId)
  if (typeof airGate?.requiredRole === 'string' && airGate.requiredRole.trim()) return airGate.requiredRole

  const approvalId = typeof approval.id === 'string' ? approval.id : undefined
  const authorization = [...events].reverse().find(event => {
    if (event.type !== 'APPROVAL_AUTHORIZATION_GRANTED') return false
    const payload = record(event.payload)
    return (approvalId !== undefined && payload?.approvalId === approvalId)
      || (gateId !== undefined && payload?.gateId === gateId)
  })
  const authorizationRole = record(authorization?.payload)?.requiredRole
  return typeof authorizationRole === 'string' && authorizationRole.trim() ? authorizationRole : undefined
}

/** Add approval policy data from persisted AIR/events; never invent it in the browser. */
export function projectPersistedState(state: unknown): unknown {
  const projected = record(state)
  const approval = record(projected?.approval)
  if (!projected || !approval) return state
  const requiredRole = persistedApprovalRole(projected, approval)
  return {
    ...projected,
    approval: {
      ...approval,
      requiredRole: requiredRole ?? null,
    },
  }
}

function dshError(error: unknown): { code: string; message: string; details: unknown } {
  if (error instanceof z.ZodError) {
    return {
      code: 'KERNL_INVALID_REQUEST',
      message: 'Request did not match the required Kernl DTO.',
      details: error.issues.map(issue => ({ code: issue.code, path: issue.path.join('.'), message: issue.message })),
    }
  }
  if (error instanceof TaskClaimAuthorityError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof TaskClaimInputError) {
    return { code: error.code, message: error.message, details: null }
  }
  return { code: 'KERNL_REQUEST_FAILED', message: errorMessage(error), details: null }
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

export function createApp(projectRoot: string) {
  const root = resolve(projectRoot)
  const coordinator = new KernlDemoCoordinator(root)
  const app = new Hono()

  app.get('/api/health', c => c.json({ ok: true, service: 'kernl', mode: 'deterministic' }))
  app.get('/api/state', async c => c.json(projectPersistedState(await coordinator.state(c.req.query('runId')))))
  app.post('/api/demo', async c => {
    const result = await coordinator.runDemo()
    return c.json({ runId: result.runId, status: result.status, approvalId: result.approvalId })
  })
  app.post('/api/approve', async c => {
    const input = approvalSchema.parse(await body(c))
    return c.json(await coordinator.approveAndPromote(input.runId, input.actor, input.role))
  })
  app.post('/api/replay', async c => {
    const input = replaySchema.parse(await body(c))
    return c.json(await coordinator.replay(input.runId))
  })

  const dshRoute = <T>(handler: (request: unknown) => Promise<T>) => async (c: Context) => {
    try {
      return c.json({ ok: true as const, value: await handler(await body(c)) })
    } catch (error) {
      return c.json({
        ok: false as const,
        error: dshError(error),
      }, 400)
    }
  }

  app.post('/api/dsh/validate-change', dshRoute(async request => {
    const record = request && typeof request === 'object' ? request as Record<string, unknown> : {}
    return coordinator.validateChange(record.air ?? request)
  }))
  app.post('/api/dsh/compile-plan', dshRoute(request => coordinator.compilePlan(request)))
  app.post('/api/dsh/claim-task', dshRoute(request => coordinator.dshClaimTask(dshClaimTaskSchema.parse(request))))
  app.post('/api/dsh/record-result', dshRoute(request => coordinator.dshRecordResult(dshRecordResultSchema.parse(request))))
  app.post('/api/dsh/verify', dshRoute(request => coordinator.dshVerification(request)))

  const webDist = join(root, 'apps', 'web', 'dist')
  registerV2Routes(app, root)
  app.use('/*', serveStatic({ root: webDist }))
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }))

  app.onError((error, c) => {
    const status = error instanceof z.ZodError ? 400 : 500
    return c.json({ error: errorMessage(error), status }, status)
  })

  return { app, coordinator, webDist, async hasWebBuild() { try { await access(join(webDist, 'index.html')); return true } catch { return false } } }
}
