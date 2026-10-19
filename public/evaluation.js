export function normalizeEvent(raw,index=0){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error(`Event ${index+1}: expected an object.`);
  const required=['id','source','title','description'];
  for(const key of required)if(typeof raw[key]!=='string'||!raw[key].trim())throw Error(`Event ${index+1}: ${key} is required.`);
  if(!['Zenity','Troj'].includes(raw.source))throw Error(`Event ${raw.id}: source must be Zenity or Troj.`);
  if(raw.analyst_label!=null&&!['TP','FP'].includes(raw.analyst_label))throw Error(`Event ${raw.id}: analyst_label must be TP, FP, or null.`);
  if(raw.description.length>20000||raw.title.length>500||raw.id.length>200)throw Error(`Event ${raw.id.slice(0,40)}: text exceeds the input limit.`);
  if(raw.relevant_context_ids!=null&&(!Array.isArray(raw.relevant_context_ids)||raw.relevant_context_ids.length>1000||raw.relevant_context_ids.some(id=>typeof id!=='string'||!id.trim()||id.length>200)||new Set(raw.relevant_context_ids).size!==raw.relevant_context_ids.length))throw Error('relevant_context_ids must contain unique, non-empty reference document IDs.');
  const e={id:raw.id,source:raw.source,title:raw.title,description:raw.description,severity:['critical','high','medium','low'].includes(raw.severity)?raw.severity:'medium',occurred_at:raw.occurred_at||null,attributes:raw.attributes&&typeof raw.attributes==='object'?raw.attributes:{},analyst_label:raw.analyst_label||null,reference_explanation:typeof raw.reference_explanation==='string'?raw.reference_explanation:''};
  if(raw.relevant_context_ids!=null)e.relevant_context_ids=[...raw.relevant_context_ids];
  if(raw.contexts)e.contexts=normalizeContexts(raw.contexts);
  if(raw.decision)e.decision=validateDecision(raw.decision,e.contexts||[],false);
  return e;
}
export function normalizeContexts(items){
  if(!Array.isArray(items)||items.length>20)throw Error('Retrieval must return a contexts array with at most 20 items.');
  const seen=new Set();
  return items.map((c,i)=>{if(!c||typeof c.id!=='string'||!c.id||typeof c.text!=='string'||!c.text.trim()||c.text.length>16000)throw Error(`Context ${i+1} needs a unique id and non-empty text (up to 16,000 characters).`);if(seen.has(c.id))throw Error('Duplicate context IDs are not allowed.');seen.add(c.id);if(c.score!=null&&(typeof c.score!=='number'||!Number.isFinite(c.score)))throw Error('Context retrieval scores must be finite numbers.');return{id:c.id,title:typeof c.title==='string'?c.title:c.id,text:c.text,score:c.score??null};});
}
export function classifierInput(event,contexts,policy){
  // Analyst labels and reference explanations are intentionally excluded.
  return {event:{id:event.id,source:event.source,title:event.title,description:event.description,severity:event.severity,occurred_at:event.occurred_at,attributes:event.attributes},contexts:contexts.map(({id,title,text})=>({id,title,text})),classification_policy:policy};
}
export function validateDecision(d,contexts,checkCitations=true){
  if(!d||!['TP','FP'].includes(d.verdict)||typeof d.confidence!=='number'||!Number.isFinite(d.confidence)||d.confidence<0||d.confidence>1||typeof d.rationale!=='string'||!d.rationale.trim()||!Array.isArray(d.cited_context_ids)||d.cited_context_ids.some(x=>typeof x!=='string')||typeof d.insufficient_evidence!=='boolean')throw Error('The classifier returned an invalid decision. No result was accepted.');
  const ids=new Set(contexts.map(c=>c.id));if(checkCitations&&d.cited_context_ids.some(id=>!ids.has(id)))throw Error('The classifier cited a context that was not retrieved.');
  return{verdict:d.verdict,confidence:d.confidence,rationale:d.rationale,cited_context_ids:[...new Set(d.cited_context_ids)],insufficient_evidence:d.insufficient_evidence,model:typeof d.model==='string'?d.model:undefined};
}
export function validateJudge(j,contexts,event){
  if(!j||typeof j.evidence_support!=='number'||!Number.isFinite(j.evidence_support)||j.evidence_support<0||j.evidence_support>1||typeof j.reason!=='string'||!Array.isArray(j.claims)||j.claims.length<1||j.claims.length>30)throw Error('The evaluator returned an invalid result.');
  for(const c of j.claims)if(typeof c.text!=='string'||typeof c.supported!=='boolean'||typeof c.reason!=='string')throw Error('The evaluator returned an invalid claim.');
  const verdicts=j.context_verdicts,referenceClaims=j.reference_claims;
  if(contexts){
    if(!Array.isArray(verdicts)||verdicts.length!==contexts.length||new Set(verdicts.map(v=>v.context_id)).size!==contexts.length||verdicts.some(v=>!contexts.some(c=>c.id===v.context_id)||typeof v.relevant!=='boolean'||typeof v.reason!=='string'))throw Error('The evaluator must assess each retrieved context exactly once.');
    if(!Array.isArray(referenceClaims)||referenceClaims.length>50||referenceClaims.some(c=>typeof c.text!=='string'||!c.text.trim()||typeof c.covered!=='boolean'||typeof c.reason!=='string'))throw Error('The evaluator returned invalid reference claim coverage.');
    if(event?.reference_explanation?.trim()?!referenceClaims.length:referenceClaims.length)throw Error('Reference coverage must use the supplied analyst explanation.');
  }
  return{evidence_support:j.claims.filter(c=>c.supported).length/j.claims.length,reason:j.reason,claims:j.claims,context_verdicts:verdicts||[],reference_claims:referenceClaims||[],context_relevance:verdicts?.length?verdicts.filter(v=>v.relevant).length/verdicts.length:null,context_sufficiency:referenceClaims?.length?referenceClaims.filter(c=>c.covered).length/referenceClaims.length:null};
}
export function retrievalMetrics(event,contexts,k){
  if(!Array.isArray(event.relevant_context_ids)||!Number.isInteger(k)||k<1)return{precision:null,recall:null,hits:null,k,referenceCount:null};
  const reference=new Set(event.relevant_context_ids),retrieved=new Set(contexts.slice(0,k).map(c=>c.id));
  const hits=[...retrieved].filter(id=>reference.has(id)).length;
  // Strict Precision@k: unfilled retrieval positions count as misses.
  return{precision:hits/k,recall:reference.size?hits/reference.size:null,hits,k,referenceCount:reference.size};
}
export function summarize(results){
  const scored=results.filter(r=>r.decision&&!r.error),labelled=scored.filter(r=>['TP','FP'].includes(r.event.analyst_label));
  let tp=0,tn=0,fp=0,fn=0;
  for(const r of labelled){const predicted=r.decision.verdict,actual=r.event.analyst_label;if(actual==='TP'&&predicted==='TP')tp++;else if(actual==='FP'&&predicted==='FP')tn++;else if(actual==='FP')fp++;else fn++;}
  const precision=tp+fp?tp/(tp+fp):null,recall=tp+fn?tp/(tp+fn):null;
  const f1=2*tp+fp+fn?2*tp/(2*tp+fp+fn):null;
  const support=results.map(r=>r.judge?.evidence_support).filter(x=>Number.isFinite(x));
  const faithfulness=results.map(r=>r.ragas?.faithfulness?.value).filter(x=>Number.isFinite(x));
  const means={};
  for(const [name,read] of Object.entries({contextRelevance:r=>r.judge?.context_relevance,contextSufficiency:r=>r.judge?.context_sufficiency,contextRecall:r=>r.ragas?.context_recall?.value,contextPrecision:r=>r.ragas?.context_precision?.value,answerFactuality:r=>r.ragas?.factual_correctness?.value,precisionAtK:r=>r.retrieval?.precision,recallAtK:r=>r.retrieval?.recall})){const values=results.map(read).filter(Number.isFinite);means[name]=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;means[name+'Count']=values.length;}
  return{...means,completed:scored.length,labelled:labelled.length,unlabelled:scored.length-labelled.length,tp,tn,fp,fn,precision,recall,f1,accuracy:labelled.length?(tp+tn)/labelled.length:null,predictedTP:scored.filter(r=>r.decision.verdict==='TP').length,predictedFP:scored.filter(r=>r.decision.verdict==='FP').length,evidenceSupport:support.length?support.reduce((a,b)=>a+b,0)/support.length:null,supportCount:support.length,faithfulness:faithfulness.length?faithfulness.reduce((a,b)=>a+b,0)/faithfulness.length:null,ragasCount:faithfulness.length,errors:results.filter(r=>r.error).length,evalErrors:results.filter(r=>r.evaluationError).length,tokens:results.reduce((sum,r)=>sum+(r.tokens||0),0)};
}
export function validateServiceURL(value){
  let u;try{u=new URL(value);}catch{throw Error('Enter a complete HTTPS service URL.');}
  if(u.username||u.password||u.search||u.hash)throw Error('Use a service base URL without credentials, query parameters, or fragments.');
  const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))throw Error('Remote services must use HTTPS.');
  return u.href.replace(/\/$/,'');
}
export function safeExport(run){return {...run,config:{...run.config,apiKey:undefined,emsToken:undefined,ragasToken:undefined},exported_at:new Date().toISOString()};}
