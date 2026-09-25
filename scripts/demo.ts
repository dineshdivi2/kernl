import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernlDemoCoordinator } from '@kernl/runtime'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const approveIndex = process.argv.indexOf('--approve')
const actor = approveIndex >= 0 ? process.argv[approveIndex + 1] : undefined
if (approveIndex >= 0 && !actor) throw new Error('--approve requires an actor name')
const roleIndex = process.argv.indexOf('--role')
const role = roleIndex >= 0 ? process.argv[roleIndex + 1] : undefined
if (approveIndex >= 0 && (!role || role.startsWith('--'))) throw new Error('--approve requires --role architect')
if (roleIndex >= 0 && (!role || role.startsWith('--'))) throw new Error('--role requires a role name')

const coordinator = new KernlDemoCoordinator(resolve(projectRoot))
const result = await coordinator.runDemo(actor, role)

console.log(JSON.stringify({
  outcome: result.status,
  runId: result.runId,
  baseCommit: result.baseCommit,
  candidateCommit: result.candidateCommit,
  verificationDigest: result.verificationDigest,
  workflowDigest: result.workflowDigest ?? null,
  evidenceManifestDigest: result.evidenceManifestDigest ?? null,
  artifactDir: result.artifactDir,
}, null, 2))

if (result.status === 'AWAITING_APPROVAL') {
  console.log(`Approve explicitly with: pnpm demo -- --approve <architect-name> --role architect (creates a new run), or POST /api/approve for ${result.runId}`)
}
