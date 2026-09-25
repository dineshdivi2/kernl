import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {it,expect,describe} from 'vitest'
import {GitWorkspaceManager} from '../../packages/runtime/src/git-workspaces.js'
import {KernlLedger,parseAir,airDigest} from '../../packages/core/src/index.js'
import type {RuntimeTask} from '../../packages/runtime/src/types.js'

describe('durable execution recovery',()=>{
  it('freezes inputs, fences duplicate executors, and persists operation results across reopen',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'kernl-ledger-recovery-'))
    const db=join(dir,'run.sqlite')
    const air=parseAir(JSON.parse(await readFile(join(process.cwd(),'fixtures/air/before.json'),'utf8')))
    let ledger=new KernlLedger(db)
    try {
      ledger.putAir(air);ledger.createRun({id:'recovery',airDigest:airDigest(air),sourceCommit:'baseline',status:'PLANNING'})
      ledger.freezeRunInputs('recovery',{revision:1})
      expect(()=>ledger.freezeRunInputs('recovery',{revision:2})).toThrow('immutable')
      const epoch=ledger.acquireExecution('recovery','owner-a')
      expect(()=>ledger.acquireExecution('recovery','owner-b')).toThrow()
      ledger.planOperation('recovery','write',{content:'ordinary output'})
      ledger.commitOperation('recovery','write',{commit:'exact-commit'})
      ledger.releaseExecution('recovery','owner-a',epoch)
      ledger.close();ledger=new KernlLedger(db)
      expect(ledger.getRunInputs('recovery')).toEqual({revision:1})
      expect(ledger.operation('recovery','write')?.result).toEqual({commit:'exact-commit'})
      expect(()=>ledger.commitOperation('recovery','write',{commit:'different-commit'})).toThrow()
      const next=ledger.acquireExecution('recovery','owner-b')
      expect(next).toBeGreaterThan(epoch)
      expect(()=>ledger.renewExecution('recovery','owner-a',epoch)).toThrow()
    } finally {ledger.close();await rm(dir,{recursive:true,force:true})}
  })
  for (const phase of ['worktree-created','files-written','task-committed','integrated']) it(`recovers a stopped task after ${phase} without a duplicate merge`,{timeout:60000},async()=>{
    const dir=await mkdtemp(join(tmpdir(),'kernl-git-recovery-'))
    try {
      const manager=new GitWorkspaceManager(dir)
      const repository=await manager.createRunRepository('recovery',join(process.cwd(),'fixtures/job-system-template'),true)
      const task:RuntimeTask={id:'ordinary-file',title:'Add a scoped TypeScript constant',kind:'worker-refactor',dependencies:[],allowedPaths:['src/recovery.ts'],architectureNodeIds:['worker'],contracts:[],acceptanceGates:[],forbiddenActions:['modify-verification'],attempt:1,maxAttempts:1}
      const proposal={adapter:'deterministic' as const,taskId:task.id,summary:task.title,mutations:[{path:'src/recovery.ts',content:'export const recovery = true\n'}]}
      await expect(manager.executeTask(repository,task,proposal,{recover:true,baseCommit:repository.baseCommit,checkpoint:at=>{if(at===phase)throw new Error('simulated interruption')}})).rejects.toThrow('simulated interruption')
      const recovered=await manager.executeTask(repository,task,proposal,{recover:true,baseCommit:repository.baseCommit})
      const repeated=await manager.executeTask(repository,task,proposal,{recover:true,baseCommit:repository.baseCommit})
      expect(repeated).toEqual(recovered)
      expect(recovered.changedPaths).toEqual(['src/recovery.ts'])
      expect(await manager.currentCommit(repository.integrationDir)).toBe(recovered.integratedCommit)
    } finally {await rm(dir,{recursive:true,force:true})}
  })
})
