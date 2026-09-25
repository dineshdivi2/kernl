import { digestJson, redactText } from '@kernl/core'
import type { AgentMutation } from './types.js'

export type ProviderId = 'deepseek' | 'openrouter' | 'nous'
export interface ProviderSelection { provider: ProviderId; model: string }
export interface CompletionResult {
  content: string
  provenance: { provider: ProviderId; requestedModel: string; servedModel: string; requestDigest: string; responseDigest: string; promptUnits: number; outputUnits: number; costUsd: number | null }
}
const definitions = {
  deepseek: { base: 'https://api.deepseek.com', key: 'DEEPSEEK_API_KEY', model: 'deepseek-flash' },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', model: 'deepseek/deepseek-v4-flash' },
  nous: { base: 'https://inference-api.nousresearch.com/v1', key: 'NOUS_API_KEY', model: 'Hermes-4-70B' },
} as const

export function providerStatus(environment: NodeJS.ProcessEnv = process.env) {
  return Object.entries(definitions).map(([id, definition]) => ({
    id: id as ProviderId, configured: Boolean(environment[definition.key] || (id === 'nous' && environment.HERMES_API_KEY)),
    model: environment[`KERNL_${id.toUpperCase()}_MODEL`] ?? definition.model,
    credentialVariable: definition.key,
  }))
}

export function knownProviderSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return ['DEEPSEEK_API_KEY','OPENROUTER_API_KEY','NOUS_API_KEY','HERMES_API_KEY'].map(key=>environment[key]).filter((value):value is string=>Boolean(value))
}

export function assertNoProviderSecrets(text: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (redactText(text,{knownSecrets:knownProviderSecrets(environment)}) !== text) throw new Error('sensitive content rejected at the model boundary')
}

/** The only external inference transport. Credentials are resolved in memory, never part of a run snapshot. */
export class ChatCompletionClient {
  constructor(private readonly transport: typeof fetch = fetch, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  private async request(selection: ProviderSelection, resource: string, body?: unknown): Promise<Record<string, any>> {
    const definition = definitions[selection.provider]
    if (!definition || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(selection.model)) throw new Error('invalid provider or model selection')
    const credential = this.environment[definition.key] ?? (selection.provider === 'nous' ? this.environment.HERMES_API_KEY : undefined)
    if (!credential) throw new Error(`${selection.provider}: credential unavailable; configure ${definition.key} in the launching environment`)
    let response: Response
    try {
      response = await this.transport(`${definition.base}/${resource}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${credential}` },
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      })
    } catch { throw new Error(`${selection.provider}: connection or timeout failure (details withheld)` ) }
    if (!response.ok) throw new Error(`${selection.provider}: HTTP ${response.status}; response body withheld`)
    const text = await response.text()
    if (text.length > 1_000_000) throw new Error('provider response exceeds size limit')
    assertNoProviderSecrets(text,this.environment)
    try { return JSON.parse(text) as Record<string, any> } catch { throw new Error('provider returned invalid JSON') }
  }

  async models(provider: ProviderId): Promise<string[]> {
    const response = await this.request({provider,model:definitions[provider].model},'models')
    return Array.isArray(response.data) ? response.data.map((m: {id?: unknown})=>m.id).filter((id: unknown):id is string=>typeof id==='string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(id)) : []
  }

  async complete(selection: ProviderSelection, system: string, prompt: string, maximumOutput = 3072): Promise<CompletionResult> {
    assertNoProviderSecrets(system+prompt,this.environment)
    if (system.length+prompt.length > 64_000) throw new Error('model context exceeds the 64 KB limit')
    if (!Number.isInteger(maximumOutput) || maximumOutput<1 || maximumOutput>4096) throw new Error('invalid model output limit')
    const body = {
      model:selection.model, messages:[{role:'system',content:system},{role:'user',content:prompt}],
      stream:false, max_tokens:maximumOutput, temperature:0,
      ...(selection.provider === 'nous' ? {} : {response_format:{type:'json_object'}}),
      ...(selection.provider === 'deepseek' ? {thinking:{type:'disabled'}} : {}),
      ...(selection.provider === 'openrouter' ? {provider:{allow_fallbacks:false},reasoning:{enabled:false}} : {}),
    }
    const response = await this.request(selection,'chat/completions',body)
    const content = response.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim() || response.choices?.[0]?.finish_reason === 'length') throw new Error(`${selection.provider}: missing or truncated completion`)
    const usage=response.usage ?? {}
    const number=(value: unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0 ? value : 0
    return { content, provenance:{provider:selection.provider,requestedModel:selection.model,
      servedModel: typeof response.model==='string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(response.model) ? response.model : selection.model,
      requestDigest:digestJson(body),responseDigest:digestJson(content),promptUnits:number(usage.prompt_tokens),outputUnits:number(usage.completion_tokens),
      costUsd:typeof usage.cost==='number' ? number(usage.cost) : null} }
  }
}

export function parseMutationProposal(content: string): { summary: string; mutations: AgentMutation[] } {
  let data: any
  try { data=JSON.parse(content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) } catch { throw new Error('agent proposal is not valid JSON') }
  if (!data || Object.keys(data).some(key=>!['summary','mutations'].includes(key)) || !Array.isArray(data.mutations) || data.mutations.length<1 || data.mutations.length>8 || typeof data.summary!=='string' || data.summary.length>1000) throw new Error('agent proposal does not match the mutation schema')
  const paths=new Set<string>()
  for (const file of data.mutations) {
    if (!file || typeof file.path!=='string' || !file.path.length || file.path.length>240 || typeof file.content!=='string' || file.content.length>80_000 || paths.has(file.path) || Object.keys(file).some(key=>!['path','content'].includes(key))) throw new Error('invalid or duplicate proposed file')
    paths.add(file.path)
  }
  return {summary:data.summary,mutations:data.mutations}
}

/** Deterministic transport for CI: no sockets, no credentials, same request/response boundary as live APIs. */
export function stubProviderTransport(reply: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(reply),{status,headers:{'Content-Type':'application/json'}})) as typeof fetch
}
