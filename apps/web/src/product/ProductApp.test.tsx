import {renderToStaticMarkup} from 'react-dom/server'
import {describe,it,expect} from 'vitest'
import {Graph,ProductApp} from './ProductApp'
import {ArchitectureEditor} from './ArchitectureEditor'
describe('product workspace',()=>{
  it('renders the authoring entry point without manufacturing completed runs',()=>{
    const html=renderToStaticMarkup(<ProductApp/> )
    expect(html).toContain('Load current baseline')
    expect(html).toContain('New architecture change')
    expect(html).not.toContain('PROMOTED')
  })
  it('exposes explicit catalog operations without implying intent generates code',()=>{
    const html=renderToStaticMarkup(<ArchitectureEditor draft={{title:'Change',intent:'Retry',componentOps:[],requestedVerification:{gates:['build']}}} baseline={{components:[]}} catalog={[{id:'retry-policy',type:'POLICY',version:'1.0.0',gates:['retry-contract']}]} onChange={()=>{}}/>)
    expect(html).toContain('retry-policy')
    expect(html).toContain('Stage addition')
    expect(html).toContain('Stage version change')
    expect(html).toContain('Stage removal')
    expect(html).toContain('does not generate operations')
  })
  it('renders exact versions and bindings from its AIR input',()=>{
    const html=renderToStaticMarkup(<Graph label="Proposed" air={{airVersion:'test-air',components:[{id:'api',kind:'API',version:'2.0.0'},{id:'queue',kind:'QUEUE',version:'1.0.0'}],bindings:[{id:'queue-binding',consumerId:'api',providerId:'queue',providerVersion:'1.0.0',capabilityId:'jobs.enqueue'}]}}/> )
    expect(html).toContain('test-air')
    expect(html).toContain('api requires jobs.enqueue from queue@1.0.0')
  })
})
