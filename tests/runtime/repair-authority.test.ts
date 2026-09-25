import {it,expect} from 'vitest'
import {repairAuthority} from '../../packages/runtime/src/plan-executor.js'
import {parseAir,parseCatalog,compileArchitecturePlan} from '../../packages/core/src/index.js'
import {readFileSync} from 'node:fs'
const fixture=(name:string)=>JSON.parse(readFileSync(`fixtures/${name}`,'utf8'))
it('routes a queue verification idempotency failure to the worker effect owner in both modes',()=>{
  const plan=compileArchitecturePlan(parseAir(fixture('air/before.json')),parseAir(fixture('air/after.json')),{catalog:parseCatalog(fixture('catalog/kernl-local-catalog.json'))})
  const queueGate=plan.steps.find(s=>s.id==='verify:queue')!
  for(const live of [true,false])expect(repairAuthority(plan,queueGate,'duplicate-event-effect',live)).toEqual({scopes:['src/worker.ts'],componentId:'worker'})
})
