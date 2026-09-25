import { posix, win32 } from 'node:path'
import { AirValidationError, airDigest, validateAirSemantics, type AirComponent, type AirDocument } from './air.js'
import { semanticDiff, type AirSemanticDiff } from './diff.js'
import { digestJson } from './hashing.js'

export type TaskKind = 'VALIDATE' | 'IMPLEMENT' | 'RETIRE' | 'INTEGRATE' | 'VERIFY' | 'APPROVAL' | 'PROMOTE' | 'REPAIR'

export interface TaskProvenance {
  changeId: string
  fromAirVersion: string
  toAirVersion: string
  fromAirDigest: string
  toAirDigest: string
  affectedBy: string[]
}

export interface CompiledTask {
  id: string
  kind: TaskKind
  title: string
  componentIds: string[]
  dependsOn: string[]
  writeScopes: string[]
  deterministic: boolean
  requiresApproval: boolean
  maxAttempts: number
  provenance: TaskProvenance
}

export interface CompiledTaskDag {
  id: string
  changeId: string
  fromAirVersion: string
  toAirVersion: string
  fromAirDigest: string
  toAirDigest: string
  directlyAffectedNodeIds: string[]
  affectedNodeIds: string[]
  tasks: CompiledTask[]
  parallelGroups: string[][]
  digest: string
}

export interface CompileTaskDagOptions {
  maximumRepairAttempts?: number
  maximumParallelImplementations?: number
}

export class TaskDagValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Task DAG validation failed: ${issues.join('; ')}`)
    this.name = 'TaskDagValidationError'
    this.issues = issues
  }
}

function normalizedScope(value: string): string {
  return posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/$/, '')
}

export function writeScopesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizedScope(left)
  const normalizedRight = normalizedScope(right)
  if (normalizedLeft === normalizedRight) return true
  return normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`)
    || win32.normalize(left).toLowerCase().startsWith(`${win32.normalize(right).toLowerCase()}\\`)
    || win32.normalize(right).toLowerCase().startsWith(`${win32.normalize(left).toLowerCase()}\\`)
}

function tasksOverlap(left: CompiledTask, right: CompiledTask): boolean {
  return left.writeScopes.some((leftScope) => right.writeScopes.some((rightScope) => writeScopesOverlap(leftScope, rightScope)))
}

function hasDependencyPath(tasks: ReadonlyMap<string, CompiledTask>, from: string, target: string, visited = new Set<string>()): boolean {
  if (from === target) return true
  if (visited.has(from)) return false
  visited.add(from)
  const task = tasks.get(from)
  return task?.dependsOn.some((dependency) => hasDependencyPath(tasks, dependency, target, visited)) ?? false
}

export function validateTaskDag(tasks: readonly CompiledTask[]): string[] {
  const issues: string[] = []
  const taskMap = new Map<string, CompiledTask>()
  for (const task of tasks) {
    if (taskMap.has(task.id)) issues.push(`duplicate task id ${task.id}`)
    taskMap.set(task.id, task)
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskMap.has(dependency)) issues.push(`${task.id} depends on missing task ${dependency}`)
      if (dependency === task.id) issues.push(`${task.id} depends on itself`)
    }
  }

  const permanent = new Set<string>()
  const visiting = new Set<string>()
  const visit = (taskId: string): void => {
    if (permanent.has(taskId)) return
    if (visiting.has(taskId)) {
      issues.push(`cycle detected at ${taskId}`)
      return
    }
    visiting.add(taskId)
    for (const dependency of taskMap.get(taskId)?.dependsOn ?? []) visit(dependency)
    visiting.delete(taskId)
    permanent.add(taskId)
  }
  for (const task of tasks) visit(task.id)

  const mutating = tasks.filter((task) => task.writeScopes.length > 0)
  for (let leftIndex = 0; leftIndex < mutating.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < mutating.length; rightIndex += 1) {
      const left = mutating[leftIndex]
      const right = mutating[rightIndex]
      if (!left || !right || !tasksOverlap(left, right)) continue
      if (!hasDependencyPath(taskMap, left.id, right.id) && !hasDependencyPath(taskMap, right.id, left.id)) {
        issues.push(`${left.id} and ${right.id} have overlapping write scopes without ordering`)
      }
    }
  }
  return [...new Set(issues)]
}

function parallelGroups(tasks: readonly CompiledTask[], maximumParallel: number): string[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task]))
  const complete = new Set<string>()
  const groups: string[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((task) => task.dependsOn.every((dependency) => complete.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id))
    if (ready.length === 0) throw new TaskDagValidationError(['task graph contains a cycle'])
    for (let index = 0; index < ready.length; index += maximumParallel) {
      const group = ready.slice(index, index + maximumParallel).map((task) => task.id)
      groups.push(group)
      for (const taskId of group) {
        remaining.delete(taskId)
        complete.add(taskId)
      }
    }
  }
  return groups
}

function componentLookup(before: AirDocument, after: AirDocument): Map<string, AirComponent> {
  return new Map([...before.components, ...after.components].map((component) => [component.id, component]))
}

function taskProvenance(before: AirDocument, after: AirDocument, affectedBy: readonly string[]): TaskProvenance {
  return {
    changeId: after.change.id,
    fromAirVersion: before.airVersion,
    toAirVersion: after.airVersion,
    fromAirDigest: airDigest(before),
    toAirDigest: airDigest(after),
    affectedBy: [...affectedBy].sort(),
  }
}

function mutationTasks(before: AirDocument, after: AirDocument, diff: AirSemanticDiff, maxAttempts: number): CompiledTask[] {
  const lookup = componentLookup(before, after)
  const removed = new Set(diff.components.removed.map((component) => component.id))
  const tasks: CompiledTask[] = []
  for (const componentId of diff.directlyAffectedComponentIds) {
    const component = lookup.get(componentId)
    if (!component) continue
    const kind: TaskKind = removed.has(componentId) ? 'RETIRE' : 'IMPLEMENT'
    tasks.push({
      id: `${kind.toLowerCase()}:${componentId}`,
      kind,
      title: `${kind === 'RETIRE' ? 'Retire' : 'Implement'} ${componentId}`,
      componentIds: [componentId],
      dependsOn: ['validate:air-change'],
      writeScopes: [...new Set(component.writeScopes.map(normalizedScope))].sort(),
      deterministic: false,
      requiresApproval: false,
      maxAttempts,
      provenance: taskProvenance(before, after, diff.reasons[componentId] ?? []),
    })
  }

  tasks.sort((left, right) => left.id.localeCompare(right.id))
  for (let index = 0; index < tasks.length; index += 1) {
    const current = tasks[index]
    if (!current) continue
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = tasks[priorIndex]
      if (prior && tasksOverlap(current, prior)) current.dependsOn.push(prior.id)
    }
    current.dependsOn.sort()
  }
  return tasks
}

export function compileTaskDag(before: AirDocument, after: AirDocument, options: CompileTaskDagOptions = {}): CompiledTaskDag {
  const beforeIssues = validateAirSemantics(before)
  const afterIssues = validateAirSemantics(after)
  if (beforeIssues.length > 0 || afterIssues.length > 0) throw new AirValidationError([...beforeIssues, ...afterIssues])
  if (before.system.id !== after.system.id) throw new TaskDagValidationError(['AIR versions belong to different systems'])
  const diff = semanticDiff(before, after)
  if (diff.empty) throw new TaskDagValidationError(['AIR change is empty'])

  const maximumRepairAttempts = options.maximumRepairAttempts ?? 3
  const maximumParallel = options.maximumParallelImplementations ?? 2
  if (!Number.isInteger(maximumRepairAttempts) || maximumRepairAttempts < 1 || maximumRepairAttempts > 10) {
    throw new RangeError('maximumRepairAttempts must be an integer from 1 to 10')
  }
  if (!Number.isInteger(maximumParallel) || maximumParallel < 1 || maximumParallel > 2) {
    throw new RangeError('maximumParallelImplementations must be 1 or 2')
  }

  const provenance = taskProvenance(before, after, ['AIR_CHANGE'])
  const validation: CompiledTask = {
    id: 'validate:air-change', kind: 'VALIDATE', title: 'Validate architecture change', componentIds: diff.directlyAffectedComponentIds,
    dependsOn: [], writeScopes: [], deterministic: true, requiresApproval: false, maxAttempts: 1, provenance,
  }
  const mutations = mutationTasks(before, after, diff, maximumRepairAttempts + 1)
  const mutationIds = mutations.map((task) => task.id)
  const integrate: CompiledTask = {
    id: 'integrate:change', kind: 'INTEGRATE', title: 'Integrate isolated component changes', componentIds: diff.directlyAffectedComponentIds,
    dependsOn: mutationIds.length > 0 ? mutationIds : [validation.id], writeScopes: [], deterministic: true, requiresApproval: false, maxAttempts: 1, provenance,
  }
  const verify: CompiledTask = {
    id: 'verify:all-gates', kind: 'VERIFY', title: 'Run deterministic verification gates', componentIds: diff.affectedComponentIds,
    dependsOn: [integrate.id], writeScopes: [], deterministic: true, requiresApproval: false, maxAttempts: 1, provenance,
  }
  const approval: CompiledTask = {
    id: 'approval:promotion', kind: 'APPROVAL', title: 'Architect approves verified diff and evidence', componentIds: diff.affectedComponentIds,
    dependsOn: [verify.id], writeScopes: [], deterministic: true, requiresApproval: true, maxAttempts: 1, provenance,
  }
  const promotion: CompiledTask = {
    id: 'promote:workflow', kind: 'PROMOTE', title: 'Promote verified run to a static workflow', componentIds: diff.affectedComponentIds,
    dependsOn: [approval.id], writeScopes: [], deterministic: true, requiresApproval: false, maxAttempts: 1, provenance,
  }
  const tasks = [validation, ...mutations, integrate, verify, approval, promotion]
  const issues = validateTaskDag(tasks)
  if (issues.length > 0) throw new TaskDagValidationError(issues)

  const draft = {
    id: `dag:${after.change.id}`,
    changeId: after.change.id,
    fromAirVersion: before.airVersion,
    toAirVersion: after.airVersion,
    fromAirDigest: airDigest(before),
    toAirDigest: airDigest(after),
    directlyAffectedNodeIds: diff.directlyAffectedComponentIds,
    affectedNodeIds: diff.affectedComponentIds,
    tasks,
    parallelGroups: parallelGroups(tasks, maximumParallel),
  }
  return { ...draft, digest: digestJson(draft) }
}

export function compileRepairTask(failedTask: CompiledTask, failureCode: string, repairAttempt: number): CompiledTask {
  if (repairAttempt < 1 || repairAttempt >= failedTask.maxAttempts) {
    throw new RangeError(`Repair attempt ${repairAttempt} exceeds limit for ${failedTask.id}`)
  }
  return {
    ...failedTask,
    id: `repair:${failedTask.id}:${repairAttempt}`,
    kind: 'REPAIR',
    title: `Repair ${failedTask.title} after ${failureCode}`,
    dependsOn: [],
    maxAttempts: 1,
    provenance: { ...failedTask.provenance, affectedBy: [...failedTask.provenance.affectedBy, `VERIFICATION_FAILURE:${failureCode}`].sort() },
  }
}
