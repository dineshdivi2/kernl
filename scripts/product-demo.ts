import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createV2App} from '../apps/server/src/v2.js'
import {providerStatus,runPromotedWorkflowReplayV2} from '../packages/runtime/src/index.js'

const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
process.env.KERNL_DB??=join(root,'data','product-alpha.sqlite')
const app=createV2App(root)
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1]}
async function request(path:string,body?:unknown,method='POST'):Promise<any> {
  const response=await app.request(`/api/v2/${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const envelope=await response.json() as any
  if(!envelope.ok)throw new Error(envelope.error??'API request failed')
  return envelope.value
}
const bootstrap=await request('bootstrap')
const proposal=bootstrap.proposals?.[0]
if(!proposal)throw new Error('No compatible demo template remains for the active baseline. Create a custom change in the product workspace.')
const draft=await request('drafts',{...proposal,title:`Product demo ${new Date().toISOString()}`})
const compiled=await request(`drafts/${draft.draftId}/compile`)
const selected=argument('--provider')
const provider=selected?providerStatus().find(p=>p.id===selected):undefined
if(selected&&!provider)throw new Error('provider must be deepseek, openrouter or nous')
const agent=provider?{provider:provider.id,model:argument('--model')??provider.model,maximumRequests:6,maximumOutputTokens:3072}:undefined
const result=await request(`drafts/${draft.draftId}/run`,agent?{agent}:{})
console.log(JSON.stringify({phase:'execution',...result}))
if(result.outcome.status!=='AWAITING_APPROVAL')process.exitCode=1
else {
  const actor=argument('--approve')
  if(actor) {
    const evidence=await request(`runs/${result.runId}/evidence`,undefined,'GET')
    const promoted=await request(`runs/${result.runId}/approve`,{actor,role:'architect',evidenceDigest:evidence.core.digest})
    console.log(JSON.stringify({phase:'promotion',...promoted}))
    if(promoted.outcome.status!=='PROMOTED')process.exitCode=1
    if(process.argv.includes('--replay')&&promoted.outcome.status==='PROMOTED') {
      const artifactDir=join(root,'artifacts','runs',result.runId)
      console.log(JSON.stringify({phase:'static-replay',...await runPromotedWorkflowReplayV2({projectRoot:root,workflowArtifactPath:join(artifactDir,'promoted-workflow.json'),beforeAirPath:join(artifactDir,'air-before.json'),afterAirPath:join(artifactDir,'air-after.json'),fixtureDir:join(root,'fixtures','job-system-template')})}))
    }
  }
  const inspected=await request(`runs/${result.runId}`,undefined,'GET')
  console.log(JSON.stringify({runId:result.runId,airVersion:compiled.airVersion,sourceCommit:inspected.run.sourceCommit,modelRequests:inspected.events.filter((e:any)=>e.type==='MODEL_REQUEST'&&!e.payload.simulated).length,artifactDirectory:join(root,'artifacts','runs',result.runId),status:inspected.run.status}))
}
