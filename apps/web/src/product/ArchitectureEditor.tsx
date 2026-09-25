import {useState} from 'react'
type Data=Record<string,any>

export function ArchitectureEditor({draft,baseline,catalog,onChange,selected='',onSelect=()=>{}}:{draft:Data;baseline:Data|undefined;catalog:Data[];onChange:(draft:Data)=>void;selected?:string;onSelect?:(id:string)=>void}) {
  const [catalogKey,setCatalogKey]=useState(''),[componentId,setComponentId]=useState('')
  const [requirement,setRequirement]=useState(''),[provider,setProvider]=useState('')
  const nodes:Data[]=baseline?.components??[]
  const component=nodes.find(node=>node.id===selected)
  const manifest=catalog.find(item=>`${item.type}:${item.id}:${item.version}`===catalogKey)
  const append=(op:Data)=>onChange({...draft,componentOps:[...draft.componentOps,op],requestedVerification:{gates:[...new Set([...draft.requestedVerification.gates,...(['ADD','UPGRADE'].includes(op.op)?manifest?.gates??[]:[])])]}})
  return <section className="kp-card"><h2>Design the change</h2>
    <p>Changes are staged until you validate and compile. Intent is descriptive; it does not generate operations.</p>
    <label>Change title <input value={draft.title} onChange={e=>onChange({...draft,title:e.target.value})}/></label>
    <label>Intent <input value={draft.intent} onChange={e=>onChange({...draft,intent:e.target.value})}/></label>
    <label>Existing component <select value={selected} onChange={e=>{onSelect(e.target.value);setRequirement('')}}><option value="">Select component</option>{nodes.map(node=><option key={node.id} value={node.id}>{node.id} · {node.version}</option>)}</select></label>
    <label>Catalog component / version <select value={catalogKey} onChange={e=>setCatalogKey(e.target.value)}><option value="">Select catalog entry</option>{catalog.map(item=>{const key=`${item.type}:${item.id}:${item.version}`;return <option key={key} value={key}>{item.id} · {item.type} · {item.version}</option>})}</select></label>
    {manifest&&<p>{manifest.description} · Verification: {manifest.gates.join(', ')}</p>}
    <label>New component ID <input value={componentId} onChange={e=>setComponentId(e.target.value)}/></label>
    <div className="kp-actions"><button disabled={!manifest||!componentId.trim()} onClick={()=>append({op:'ADD',componentId:componentId.trim(),catalogType:manifest!.type,catalogId:manifest!.id,catalogVersion:manifest!.version})}>Stage addition</button>
      <button disabled={!component||!manifest} onClick={()=>append({op:'UPGRADE',componentId:selected,catalogType:manifest!.type,catalogVersion:manifest!.version})}>Stage version change</button>
      <button disabled={!component} onClick={()=>append({op:'REMOVE',componentId:selected})}>Stage removal</button></div>
    {component&&<><h3>Change exact dependency</h3><label>Requirement <select value={requirement} onChange={e=>setRequirement(e.target.value)}><option value="">Select requirement</option>{(component.requires??[]).map((r:Data)=><option key={r.id} value={r.id}>{r.id}</option>)}</select></label>
      <label>Provider component <select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">Select provider</option>{nodes.filter(node=>node.id!==selected).map(node=><option key={node.id} value={node.id}>{node.id}</option>)}</select></label>
      <button disabled={!component.requires?.some((r:Data)=>r.id===requirement)||!provider} onClick={()=>append({op:'REBIND',componentId:selected,requirementId:requirement,providerComponentId:provider})}>Stage binding</button></>}
    <h3>Staged operations ({draft.componentOps.length})</h3>
    {draft.componentOps.map((op:Data,index:number)=><div className="kp-step" key={index}><code>{op.op} {op.componentId} {op.catalogVersion??op.providerComponentId??''}</code><button aria-label={`Undo operation ${index+1}`} onClick={()=>onChange({...draft,componentOps:draft.componentOps.filter((_:Data,i:number)=>i!==index)})}>Undo</button></div>)}
    <p className="kp-caption">Local jobs-system catalog only. Validation checks compatibility and bindings. Advanced contract edits remain available in JSON.</p>
  </section>
}
