import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPromotedWorkflowReplay } from '@kernl/runtime'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(`${name} requires a path`)
  return resolve(projectRoot, value ?? fallback)
}

const runIdIndex = process.argv.indexOf('--run-id')
const replayRunId = runIdIndex >= 0 ? process.argv[runIdIndex + 1] : undefined
if (runIdIndex >= 0 && (!replayRunId || replayRunId.startsWith('--'))) throw new Error('--run-id requires a value')

const outputDir = argument('--output', join('artifacts', 'workflow-replay'))
const report = await runPromotedWorkflowReplay({
  projectRoot,
  workflowArtifactPath: argument('--workflow', join('artifacts', 'demo-run', 'promoted-workflow.json')),
  promotionArtifactPath: argument('--promotion', join('artifacts', 'demo-run', 'promotion.json')),
  beforeAirPath: argument('--before', join('fixtures', 'air', 'before.json')),
  afterAirPath: argument('--after', join('fixtures', 'air', 'after.json')),
  replacementAirPath: argument('--replacement', join('fixtures', 'air', 'queue-v2.json')),
  fixtureDir: argument('--fixture', join('fixtures', 'job-system-template')),
  outputDir,
  ...(replayRunId ? { replayRunId } : {}),
})

console.log(JSON.stringify({
  status: report.status,
  reportPath: resolve(outputDir, report.reportPath),
  reportDigest: report.reportDigest,
  evidenceManifestPath: resolve(outputDir, report.evidenceManifestPath),
  workflowContentDigest: report.workflow.contentDigest,
  workflowArtifactDigest: report.workflow.artifactDigest,
  promotedWorkflowDigest: report.workflow.promotedWorkflowDigest,
  baseCommit: report.source.baseCommit,
  candidateCommit: report.source.candidateCommit,
  verificationAttempts: report.verification.attempts.length,
  initialFailureFingerprint: report.verification.initialFailureFingerprint,
  repairScope: report.repair.changedPaths,
  finalStatus: report.verification.finalStatus,
}, null, 2))
