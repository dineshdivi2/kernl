import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernlDemoCoordinator } from '@kernl/runtime'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runIndex = process.argv.indexOf('--run')
const runId = runIndex >= 0 ? process.argv[runIndex + 1] : undefined
const coordinator = new KernlDemoCoordinator(resolve(projectRoot))
const report = await coordinator.replay(runId)
const full = process.argv.includes('--full')

console.log(JSON.stringify(full ? report : {
  status: report.status,
  runId: report.runId,
  stateDigest: report.stateDigest,
  stableAcrossRestart: report.stableAcrossRestart,
  eventCount: report.eventCount,
  effectCount: report.effectCount,
  duplicateEffects: report.duplicateEffects,
  effectsReexecuted: report.effectsReexecuted,
}, null, 2))
if (report.stableAcrossRestart === false) process.exitCode = 1
