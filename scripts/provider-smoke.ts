import {ChatCompletionClient,providerStatus} from '../packages/runtime/src/providers.js'
const client=new ChatCompletionClient()
const live=process.argv.includes('--live')
for (const provider of providerStatus()) {
  if (!live) {console.log(JSON.stringify(provider));continue}
  if (!provider.configured) {console.log(JSON.stringify({provider:provider.id,status:'credential-unavailable'}));continue}
  try {
    const models=await client.models(provider.id)
    const preferred=models.includes(provider.model)?provider.model:models.find(id=>provider.id==='nous'?/Hermes-4.*70B/i.test(id):/deepseek.*flash/i.test(id))
    if (!preferred) {console.log(JSON.stringify({provider:provider.id,status:'select-model',models:models.slice(0,15)}));continue}
    const response=await client.complete({provider:provider.id,model:preferred},'Return only JSON.','Return {"ok":true,"purpose":"kernl-provider-smoke"}.',96)
    const parsed=JSON.parse(response.content)
    if (parsed.ok!==true) throw new Error('unexpected smoke response')
    console.log(JSON.stringify({provider:provider.id,status:'passed',...response.provenance}))
  } catch(error) {console.log(JSON.stringify({provider:provider.id,status:'failed',error:error instanceof Error?error.message:'provider failure'}))}
}
