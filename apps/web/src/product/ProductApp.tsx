import {useEffect,useState} from 'react'
import './product.css'
import {ArchitectureEditor} from './ArchitectureEditor'

type Data=Record<string,any>
async function api(path:string,method='GET',body?:unknown):Promise<any> {
  const response=await fetch(`/api/v2/${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const result=await response.json()
  if (!result.ok) throw new Error(result.error ?? 'Request failed')
  return result.value
}
export function Graph({air,label,onSelect}:{air:Data|undefined;label:string;onSelect?:(id:string)=>void}) {
  const nodes:Data[]=air?.components??[]
  const pos=(index:number)=>({x:25+(index%3)*210,y:32+Math.floor(index/3)*145})
  return <section className="kp-card"><div className="kp-card-head"><h2>{label}</h2><small>{air?.airVersion??'Compile a draft'}</small></div>
    <svg viewBox={`0 0 655 ${Math.max(190,Math.ceil(nodes.length/3)*145+40)}`} role={onSelect?'group':'img'} aria-label={`${label} architecture graph`}>
      <defs><marker id={`arrow-${label.replaceAll(' ','')}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#80998e"/></marker></defs>
      {(air?.bindings??[]).map((binding:Data)=>{
        const p=nodes.findIndex(node=>node.id===binding.providerId),c=nodes.findIndex(node=>node.id===binding.consumerId)
        if(p<0||c<0)return null
        const a=pos(c),b=pos(p)
        return <path key={binding.id} d={`M${a.x+86},${a.y+76} C${a.x+90},${a.y+125} ${b.x+80},${b.y+125} ${b.x+86},${b.y+76}`} fill="none" stroke="#80998e" strokeWidth="2" markerEnd={`url(#arrow-${label.replaceAll(' ','')})`}><title>{binding.consumerId} requires {binding.capabilityId} from {binding.providerId}@{binding.providerVersion}</title></path>
      })}
      {nodes.map((node,index)=>{const p=pos(index);return <g key={node.id} role={onSelect?"button":undefined} tabIndex={onSelect?0:undefined} aria-label={onSelect?`Edit ${node.id}`:undefined} onClick={()=>onSelect?.(node.id)} onKeyDown={e=>{if(onSelect&&(e.key==="Enter"||e.key===" ")){e.preventDefault();onSelect(node.id)}}} transform={`translate(${p.x},${p.y})`}><rect width="172" height="76" rx="12" fill="white" stroke={node.kind==='QUEUE'?'#259479':'#b7c9bd'} strokeWidth="2"/><text x="13" y="22" fill="#718378" fontSize="10">{node.kind}</text><text x="13" y="43" fill="#163d31" fontSize="17" fontWeight="600">{node.id}</text><text x="13" y="62" fill="#63796d" fontSize="11">v{node.version} · {node.lifecycle?.initialState??'declared'}</text></g>})}
    </svg><p className="kp-caption">Arrows show exact consumer → provider bindings. Lifecycle labels here are AIR declarations; execution events are below.</p>
    <details><summary>Contracts & exact bindings</summary><pre>{JSON.stringify({bindings:air?.bindings,contracts:air?.contracts},null,2)}</pre></details>
  </section>
}

export function ProductApp() {
  const [selectedComponent,setSelectedComponent]=useState('')
  const [catalog,setCatalog]=useState<Data[]>([]),[proposals,setProposals]=useState<Data[]>([]),[baselineCommit,setBaselineCommit]=useState('')
  const [drafts,setDrafts]=useState<Data[]>([]),[runs,setRuns]=useState<Data[]>([]),[providers,setProviders]=useState<Data[]>([])
  const [starter,setStarter]=useState<Data|null>(null),[baseline,setBaseline]=useState<Data>(),[editor,setEditor]=useState(''),[draftId,setDraftId]=useState('')
  const [compiled,setCompiled]=useState<Data|null>(null),[detail,setDetail]=useState<Data|null>(null),[evidence,setEvidence]=useState<Data|null>(null)
  const [runId,setRunId]=useState(()=>typeof localStorage==='undefined'?'':localStorage.getItem('kernl.product.run')??'')
  const [provider,setProvider]=useState('deterministic'),[model,setModel]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [actor,setActor]=useState('solution-architect'),[reason,setReason]=useState(''),[tab,setTab]=useState('Architecture')
  const refresh=async()=>{const [d,r,p]=await Promise.all([api('drafts'),api('runs'),api('providers')]);setDrafts(d.drafts);setRuns(r);setProviders(p)}
  async function action(label:string,fn:()=>Promise<void>) {setBusy(label);setError('');try{await fn();await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy('')}}
  useEffect(()=>{void refresh().catch(e=>setError(String(e)))},[])
  useEffect(()=>{
    if (!runId) return
    localStorage.setItem('kernl.product.run',runId)
    let disposed=false
    const poll=async()=>{try{const next=await api(`runs/${runId}`);if(disposed)return;setDetail(next);setRuns(previous=>previous.map(run=>run.id===runId?next.run:run))
      if(next.events.some((e:Data)=>e.type==='EVIDENCE_READY')){const pack=await api(`runs/${runId}/evidence`);if(!disposed)setEvidence(pack)}
    }catch(e){if(!disposed)setError(String(e))}}
    setDetail(null);setEvidence(null);void poll();const timer=setInterval(()=>void poll(),2000)
    return()=>{disposed=true;clearInterval(timer)}
  },[runId])
  const loadStarter=()=>void action('Load architecture',async()=>{const [value,entries]=await Promise.all([api('bootstrap','POST'),api('catalog')]);setCatalog(entries.manifests);setProposals(value.proposals??[]);setBaselineCommit(value.promotion?.sourceCommit??'');setStarter(value.starter);setBaseline(value.baseline);setEditor(JSON.stringify(value.starter,null,2));setDraftId('');setCompiled(null);setTab('Architecture');setNotice('New change starts from the current baseline. Choose a template explicitly or stage catalog operations.')})
  const loadDraft=(id:string)=>void action('Open draft',async()=>{const [record,entries]=await Promise.all([api(`drafts/${id}`),api('catalog')]);setCatalog(entries.manifests);setBaseline(record.baseline);setBaselineCommit('');setProposals([]);setStarter(null);const {schemaVersion,draftId:omit,systemId,createdAt,updatedAt,...input}=record.draft;setDraftId(id);setEditor(JSON.stringify(input,null,2));setCompiled(null);setTab('Architecture')})
  const save=()=>void action('Validate & compile',async()=>{
    const input=JSON.parse(editor)
    const saved=await api(draftId?`drafts/${draftId}`:'drafts',draftId?'PUT':'POST',input)
    const id=saved.draftId;setDraftId(id)
    const validation=await api(`drafts/${id}/validate`,'POST')
    if(!validation.valid)throw new Error(validation.issues.map((issue:Data)=>`${issue.code}: ${issue.message}`).join('\n'))
    setCompiled(await api(`drafts/${id}/compile`,'POST'));setNotice('Validated. Review the affected components and write scopes before execution.')
  })
  const execute=()=>void action('Start bounded run',async()=>{
    if(!draftId||!compiled)throw new Error('Save and compile this draft first')
    const result=await api(`drafts/${draftId}/run`,'POST',{background:true,...(provider==='deterministic'?{}:{agent:{provider,model,maximumRequests:6,maximumOutputTokens:3072}})})
    setRunId(result.runId);setTab('Execution');setNotice('Run started. State and approvals survive a page reload.');setCompiled(null)
  })
  const decide=(decision:'approve'|'reject')=>void action(decision==='approve'?'Verify evidence & promote':'Reject candidate',async()=>{
    const value=await api(`runs/${runId}/${decision}`,'POST',{actor,role:'architect',evidenceDigest:evidence?.core.digest,...(decision==='reject'?{reason}: {})})
    setDetail(await api(`runs/${runId}`));setNotice(value.outcome?.status==='FAILED'?value.outcome.error:`Decision recorded: ${value.outcome?.status??value.status}`)
  })
  const reports:Data[]=(detail?.events??[]).filter((e:Data)=>e.type==='VERIFICATION_FINISHED').map((e:Data)=>e.payload)
  const steps:Data[]=detail?.context?.plan?.steps??compiled?.plan?.steps??[]
  const pending=detail?.run.status==='AWAITING_APPROVAL'
  let structuredDraft:Data|null=null
  try {const input=JSON.parse(editor);if(Array.isArray(input.componentOps)&&Array.isArray(input.requestedVerification?.gates))structuredDraft=input}catch{/* JSON stays editable while incomplete. */}
  return <div className="kp"><header className="kp-top"><a className="kp-brand" href="#">k<span>▥</span>rnl</a><span className="kp-divider"/><span>Architecture workspace</span><small>LOCAL ALPHA · JOBS SYSTEM</small></header>
    <div className="kp-layout"><aside className="kp-sidebar"><p className="kp-eyebrow">WORKSPACE</p><button className="kp-primary" disabled={!!busy} onClick={loadStarter}>＋ New architecture change</button>
      <h3>Saved changes</h3>{drafts.map(d=><button className={`kp-entry ${draftId===d.draftId?'selected':''}`} key={d.draftId} onClick={()=>loadDraft(d.draftId)}><strong>{d.title}</strong><small>{d.status} · {d.draftId}</small></button>)}
      <h3>Recent runs</h3>{runs.slice(0,15).map(r=><button className={`kp-entry ${runId===r.id?'selected':''}`} key={r.id} onClick={()=>{setRunId(r.id);setTab('Execution')}}><strong>{r.status.replaceAll('_',' ')}</strong><small>{r.id.slice(-22)}</small></button>)}
      <p className="kp-caption">AIR is design truth.<br/>Git is implementation truth.<br/>Evidence connects them.</p>
    </aside><main className="kp-main"><div className="kp-hero"><p className="kp-eyebrow">DESIGN → BUILD → VERIFY → APPROVE</p><h1>Change the architecture.<br/><span>Keep control of the software.</span></h1><p>A bounded workspace for evolving components, contracts and exact dependencies.</p></div>
      <div className="kp-tabs">{['Architecture','Execution','Evidence'].map(name=><button className={name===tab?'active':''} onClick={()=>setTab(name)} key={name}>{name}</button>)}{busy&&<span role="status">{busy}…</span>}</div>
      {error&&<pre className="kp-error" role="alert">{error}</pre>}{notice&&<p className="kp-notice" role="status">{notice}</p>}
      {tab==='Architecture'&&<>
        {!editor&&<section className="kp-card kp-welcome"><h2>Evolve the current system</h2><p>Start from the latest promoted architecture and implementation. Choose explicit changes from the local component catalog.</p><button className="kp-primary" onClick={loadStarter} disabled={!!busy}>Load current baseline</button></section>}
        <Graph air={compiled?.before??baseline??detail?.context?.fromAir} label="Before" onSelect={editor?setSelectedComponent:undefined}/>
        {baselineCommit&&<p>Baseline commit <code>{baselineCommit}</code></p>}
        {!!proposals.length&&<section className="kp-card"><h2>Compatible change templates</h2><p>These are catalog-backed templates, not AI-generated proposals. Selecting one replaces the unsaved editor.</p>{proposals.map((proposal,index)=><button key={index} disabled={!!busy} onClick={()=>{setEditor(JSON.stringify(proposal,null,2));setDraftId('');setCompiled(null)}}>Select: {proposal.title}</button>)}</section>}
        {structuredDraft&&<ArchitectureEditor key={draftId||baseline?.airVersion} draft={structuredDraft} baseline={baseline} catalog={catalog} selected={selectedComponent} onSelect={setSelectedComponent} onChange={next=>{setEditor(JSON.stringify(next,null,2));setCompiled(null)}}/>}
        {editor&&<section className="kp-card"><div className="kp-card-head"><h2>Architecture change</h2><small>{draftId||'Unsaved draft'}</small></div><label htmlFor="air-editor">Component operations, contracts & verification policy</label><textarea id="air-editor" value={editor} spellCheck={false} onChange={e=>{setEditor(e.target.value);setCompiled(null)}}/><div className="kp-actions"><button className="kp-primary" onClick={save} disabled={!!busy}>Save, validate & compile</button><button onClick={()=>{setDraftId('');setCompiled(null);setNotice('Editing a new copy. The executed draft remains locked.')}}>Save as new change</button>{starter&&<button onClick={()=>{setEditor(JSON.stringify(starter,null,2));setDraftId('');setCompiled(null)}}>Reset editor</button>}</div></section>}
        {compiled&&<><Graph air={compiled.after} label="Proposed"/><section className="kp-card"><h2>Affected subgraph</h2><p>{compiled.affectedComponentIds.join(' · ')}</p>{steps.map(s=><div className="kp-step" key={s.id}><code>{s.id}</code><small>{s.writeScopes.join(', ')||'read-only / control plane'}</small></div>)}<h3>Execution provider</h3><label>Provider <select value={provider} onChange={e=>{setProvider(e.target.value);setModel(providers.find(p=>p.id===e.target.value)?.model??'')}}><option value="deterministic">Deterministic · offline repair drill</option>{providers.map(p=><option key={p.id} value={p.id} disabled={!p.configured}>{p.id} · {p.configured?'credential available':'not configured'}</option>)}</select></label>{provider!=='deterministic'&&<><label>Model <input value={model} onChange={e=>setModel(e.target.value)}/></label><p className="kp-caption">Live code synthesis: up to 6 requests, 3 repairs, 3,072 output tokens/request. Provider billing applies; no hard dollar cap. Trusted local fixture only; worktrees are not security sandboxes.</p></>}<button className="kp-primary" disabled={!!busy} onClick={execute}>Execute reviewed plan →</button></section></>}
      </>}
      {tab==='Execution'&&<>{!detail?<section className="kp-card">Select a saved run or execute a compiled change.</section>:<><section className="kp-card"><div className="kp-card-head"><h2>{detail.run.status.replaceAll('_',' ')}</h2><code>{detail.run.id}</code></div><p>Candidate <code>{detail.run.sourceCommit}</code></p><p>{detail.tasks.filter((t:Data)=>t.status==='SUCCEEDED').length} tasks complete · {detail.events.filter((e:Data)=>e.type==='REPAIR_TASK_COMPILED').length} repair tasks · {reports.length} verification attempts</p><button disabled={!!busy||['PROMOTED','CANCELLED'].includes(detail.run.status)} onClick={()=>void action('Resume from ledger',async()=>{const out=await api(`runs/${runId}/resume`,'POST');setNotice(out.error??out.status)})}>Resume interrupted run</button></section><Graph air={detail.context.toAir} label="Target"/><section className="kp-card"><h2>Compiled task DAG</h2>{steps.map(s=>{const t=detail.tasks.find((t:Data)=>t.id===s.id);return <div className="kp-step" key={s.id}><strong>{t?.status??'PENDING'}</strong><code>{s.id}</code><small>After: {s.dependsOn.join(', ')||'start'}<br/>Writes: {s.writeScopes.join(', ')||'none'}</small></div>})}</section>{reports.map((report,index)=><section className="kp-card" key={index}><h2>Verification {report.attempt} · {report.status}</h2>{report.gates.map((g:Data)=><details key={g.name}><summary><span className={g.status==='passed'?'kp-pass':'kp-fail'}>{g.status}</span> {g.name} — {g.summary}</summary><pre>{g.stdout}{g.stderr}</pre></details>)}</section>)}<section className="kp-card"><h2>Lifecycle & effect ledger</h2><p className="kp-caption">Provider transitions below are a persisted lifecycle model, not a running hot-swap deployment.</p><details><summary>{detail.effects.length} receipts · inspect recovery metadata</summary><pre>{JSON.stringify(detail.effects,null,2)}</pre></details><details><summary>{detail.events.length} durable events · full history</summary><pre>{JSON.stringify(detail.events,null,2)}</pre></details></section></>}
      </>}
      {tab==='Evidence'&&<><section className="kp-card"><h2>Review the exact candidate</h2>{!evidence?<p>Evidence is sealed after verification, before approval.</p>:<><p>Approved core digest <code>{evidence.core.digest}</code></p><details open><summary>Generated code diff</summary><pre className="kp-diff">{evidence.diff||'No code diff'}</pre></details><details><summary>{evidence.core.files.length} sealed evidence files</summary><pre>{JSON.stringify(evidence.core.files,null,2)}</pre></details><button onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({evidence,run:detail},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`kernl-${runId}.json`;a.click();URL.revokeObjectURL(url)}}>Download inspection snapshot</button></>}</section>
        {pending&&evidence&&<section className="kp-card"><h2>Architect decision</h2><p>Approval binds this exact AIR, candidate commit and sealed evidence digest.</p><label>Actor <input value={actor} onChange={e=>setActor(e.target.value)}/></label><label>Reason for rejection <input value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="kp-actions"><button className="kp-primary" disabled={!!busy||!actor.trim()} onClick={()=>decide('approve')}>Approve exact evidence & promote</button><button disabled={!!busy||!reason.trim()} onClick={()=>decide('reject')}>Reject</button></div></section>}
        {detail?.promotion&&<section className="kp-card"><h2>Versioned workflow promoted</h2><p>Source commit <code>{detail.promotion.sourceCommit}</code></p><p>Workflow <code>{detail.promotion.workflowDigest}</code></p><details><summary>Static workflow & provenance</summary><pre>{JSON.stringify(detail.promotion,null,2)}</pre></details><p>Ledger replay status: {evidence?.projection?.status}. This reconstructs durable facts; it does not re-execute a deployment.</p></section>}</>}
    </main></div></div>
}
