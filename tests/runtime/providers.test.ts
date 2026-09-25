import {describe,it,expect} from 'vitest'
import {ChatCompletionClient,stubProviderTransport,parseMutationProposal,providerStatus,assertNoProviderSecrets} from '../../packages/runtime/src/providers.js'

describe('provider boundary (offline)',()=>{
  for (const provider of ['deepseek','openrouter','nous'] as const) it(`${provider}: normalizes an OpenAI-compatible completion without persisting credentials`,async()=>{
    const environment={DEEPSEEK_API_KEY:'fixture-only-credential',OPENROUTER_API_KEY:'fixture-only-credential',NOUS_API_KEY:'fixture-only-credential'}
    let request:RequestInit|undefined
    const client=new ChatCompletionClient(async(_url,options)=>{request=options;return stubProviderTransport({model:'fixture-model',choices:[{message:{content:'{"summary":"done","mutations":[{"path":"src/worker.ts","content":"export {}"}]}'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:20}})('https://unused.invalid')},environment)
    const reply=await client.complete({provider,model:'fixture-model'},'Return JSON','ordinary coding task')
    expect(parseMutationProposal(reply.content).mutations).toHaveLength(1)
    expect(reply.provenance.promptUnits).toBe(12)
    expect(JSON.stringify(reply)).not.toContain('fixture-only-credential')
    expect(request?.redirect).toBe('error')
    expect(JSON.stringify(providerStatus(environment))).not.toContain('fixture-only-credential')
  })
  it('does not expose a failed provider response body',async()=>{
    const client=new ChatCompletionClient(stubProviderTransport({error:'private-provider-diagnostic'},401),{DEEPSEEK_API_KEY:'fixture-only-credential'})
    await expect(client.models('deepseek')).rejects.toThrow('HTTP 401; response body withheld')
  })
  it('rejects malformed proposals and sensitive values before persistence',()=>{
    expect(()=>parseMutationProposal('{"summary":"bad","mutations":[]}')).toThrow('schema')
    expect(()=>assertNoProviderSecrets('contains fixture-secret-value',{NOUS_API_KEY:'fixture-secret-value'})).toThrow('sensitive')
  })
  it('requires an explicitly configured credential',async()=>{
    await expect(new ChatCompletionClient(stubProviderTransport({}),{}).models('nous')).rejects.toThrow('credential unavailable')
  })
})
