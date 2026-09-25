import {mkdir,cp,readFile,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {KernlLedger} from '../packages/core/src/index.js'
import {EvidenceWriter} from '../packages/runtime/src/evidence.js'
import {knownProviderSecrets} from '../packages/runtime/src/providers.js'
const root=process.cwd(),runId=process.argv[2]
if(!runId||!/^run-[A-Za-z0-9-]+$/.test(runId))throw new Error('Pass one exact generated run ID')
const ledger=new KernlLedger(process.env.KERNL_DB??join(root,'data','product-alpha.sqlite'))
const exported=ledger.exportRun(runId)
ledger.close()
const output=join('artifacts','product-alpha',runId)
await mkdir(join(root,output),{recursive:true})
const source=join(root,'artifacts','runs',runId)
const present=await readdir(source).catch(()=>[])
for(const file of present) if(file.endsWith('.json')||file.endsWith('.jsonl')||file.endsWith('.patch'))await cp(join(source,file),join(root,output,file))
const writer=new EvidenceWriter(root,output);await writer.initialize()
await writer.json('ledger-export.json',exported)
await writer.indexExisting()
for(const file of writer.entries()) {
  const bytes=await readFile(join(writer.outputDir,file.path))
  if(knownProviderSecrets().some(secret=>bytes.includes(Buffer.from(secret))))throw new Error('Export refused: credential detected')
}
await writer.manifest({kind:'product-alpha-export',runId,status:exported.run.status})
await writer.verifyFiles()
console.log(JSON.stringify({runId,status:exported.run.status,files:writer.entries().length,path:resolve(output)}))
