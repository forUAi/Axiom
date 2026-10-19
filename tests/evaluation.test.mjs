import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize,classifierInput,validateDecision,normalizeEvent,normalizeContexts,validateServiceURL} from '../public/evaluation.js';
import {handleModelRequest} from '../server/openai.mjs';
import {exampleEvents} from '../public/fixtures.js';
const decision={verdict:'TP',confidence:.9,rationale:'The context supports a policy violation.',cited_context_ids:['POL-014'],insufficient_evidence:false};
function row(actual,predicted){return{event:{analyst_label:actual},decision:{verdict:predicted}};}
test('classification uses labelled successes only and calculates TP-positive matrix',()=>{const s=summarize([row('TP','TP'),row('TP','FP'),row('FP','TP'),row('FP','FP'),row(null,'TP'),{...row('TP','TP'),error:'failed'}]);assert.deepEqual([s.tp,s.tn,s.fp,s.fn,s.labelled,s.unlabelled],[1,1,1,1,4,1]);assert.equal(s.precision,.5);assert.equal(s.recall,.5);assert.equal(s.f1,.5);assert.equal(s.accuracy,.5);});
test('undefined denominators stay null, and complete misses have F1 zero',()=>{assert.equal(summarize([row(null,'TP')]).accuracy,null);assert.equal(summarize([row('TP','FP')]).precision,null);assert.equal(summarize([row('TP','FP')]).f1,0);assert.equal(summarize([]).evidenceSupport,null);});
test('classifier payload cannot include analyst labels or reference explanations',()=>{const payload=classifierInput(exampleEvents[0],exampleEvents[0].contexts,'policy');assert.equal(payload.event.analyst_label,undefined);assert.equal(payload.event.reference_explanation,undefined);assert.ok(!JSON.stringify(payload).includes('reference_explanation'));});
test('unknown citations and invalid confidence fail closed',()=>{assert.throws(()=>validateDecision({...decision,cited_context_ids:['invented']},exampleEvents[0].contexts));assert.throws(()=>validateDecision({...decision,confidence:1.2},exampleEvents[0].contexts));});
test('adapter rejects invalid sources, duplicate contexts and insecure remote URLs',()=>{assert.throws(()=>normalizeEvent({...exampleEvents[0],source:'unknown'}));assert.throws(()=>normalizeContexts([{id:'x',text:'a'},{id:'x',text:'b'}]));assert.throws(()=>validateServiceURL('http://remote.example.com'));assert.equal(validateServiceURL('https://ems.example.test/'),'https://ems.example.test');});
function req(body,key='test-key-not-a-real-secret'){return new Request('https://axiom.test/api/classify',{method:'POST',headers:{'Content-Type':'application/json','X-OpenAI-Key':key,Origin:'https://axiom.test'},body:JSON.stringify(body)});}
test('OpenAI route strips ground truth and sends JSON schema through a fixed provider URL',async()=>{let observed;const response=await handleModelRequest(req({event:exampleEvents[0],contexts:exampleEvents[0].contexts,model:'gpt-4.1-mini'}),'classify',async(url,options)=>{observed={url,body:JSON.parse(options.body)};return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}],usage:{total_tokens:123},model:'gpt-4.1-mini'});});assert.equal(response.status,200);const result=await response.json();assert.equal(result.tokens,123);assert.equal(observed.url,'https://api.openai.com/v1/chat/completions');const payload=JSON.parse(observed.body.messages[1].content);assert.equal(payload.event.analyst_label,undefined);assert.equal(observed.body.store,false);assert.equal(observed.body.response_format.json_schema.strict,true);});
test('provider failures and absent keys do not turn into fake decisions',async()=>{let response=await handleModelRequest(req({event:exampleEvents[0],contexts:exampleEvents[0].contexts}),'classify',async()=>Response.json({error:{message:'secret-content'}},{status:429}));assert.equal(response.status,429);assert.ok(!(await response.text()).includes('secret-content'));response=await handleModelRequest(req({},''),'classify',()=>{throw Error('must not call provider');});assert.equal(response.status,401);});
test('cancelled requests, truncated responses and cross-origin calls are rejected',async()=>{let response=await handleModelRequest(req({event:exampleEvents[0],contexts:exampleEvents[0].contexts}),'classify',async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]}));assert.equal(response.status,400);const cross=new Request('https://axiom.test/api/classify',{method:'POST',headers:{Origin:'https://evil.test','X-OpenAI-Key':'test-key-not-real'},body:'{}'});response=await handleModelRequest(cross,'classify',()=>{throw Error('must not call');});assert.equal(response.status,403);});
test('evidence support is calculated from validated claim verdicts',async()=>{const {validateJudge}=await import('../public/evaluation.js');const j=validateJudge({evidence_support:1,reason:'Mixed support',claims:[{text:'A',supported:true,reason:'Provided'},{text:'B',supported:false,reason:'Absent'}]});assert.equal(j.evidence_support,.5);assert.throws(()=>validateJudge({evidence_support:1,reason:'None',claims:[]}));});

test('retrieval metrics use requested k and a complete independent relevance set',async()=>{
 const {retrievalMetrics}=await import('../public/evaluation.js');
 const event={relevant_context_ids:['a','b','missing']};
 const r=retrievalMetrics(event,[{id:'a'},{id:'noise'},{id:'b'}],5);
 assert.equal(r.precision,2/5);assert.equal(r.recall,2/3);assert.equal(r.hits,2);
 assert.equal(retrievalMetrics({},[{id:'a'}],5).precision,null);
 assert.equal(retrievalMetrics({relevant_context_ids:[]},[{id:'a'}],5).precision,0);
 assert.equal(retrievalMetrics({relevant_context_ids:[]},[{id:'a'}],5).recall,null);
 assert.equal(retrievalMetrics(event,[{id:'a'},{id:'a'}],2).precision,.5);
 assert.throws(()=>normalizeEvent({...exampleEvents[0],relevant_context_ids:['a','a']}));
});
test('judge calculates relevance and reference coverage from separate atomic verdicts',async()=>{
 const {validateJudge}=await import('../public/evaluation.js');
 const contexts=[{id:'a',text:'a'},{id:'b',text:'b'}];
 const result={evidence_support:1,reason:'Check',claims:[{text:'one',supported:true,reason:'in a'},{text:'two',supported:false,reason:'missing'}],context_verdicts:[{context_id:'a',relevant:true,reason:'useful'},{context_id:'b',relevant:false,reason:'unrelated'}],reference_claims:[{text:'fact 1',covered:true,reason:'a'},{text:'fact 2',covered:false,reason:'missing'}]};
 const j=validateJudge(result,contexts,{reference_explanation:'fact 1 and fact 2'});
 assert.equal(j.evidence_support,.5);assert.equal(j.context_relevance,.5);assert.equal(j.context_sufficiency,.5);
 assert.throws(()=>validateJudge({...result,context_verdicts:[result.context_verdicts[0],result.context_verdicts[0]]},contexts,{reference_explanation:'facts'}));
 assert.throws(()=>validateJudge(result,contexts,{reference_explanation:''}));
 assert.equal(validateJudge({...result,reference_claims:[]},contexts,{}).context_sufficiency,null);
});
test('new metric aggregates exclude unavailable values instead of substituting zero',()=>{
 const s=summarize([{judge:{context_relevance:0,context_sufficiency:null},retrieval:{precision:.4,recall:.5},ragas:{context_recall:{status:'skipped',value:null}}},{judge:{context_relevance:1,context_sufficiency:.75},ragas:{context_recall:{status:'ok',value:.8},factual_correctness:{status:'ok',value:.6}}}]);
 assert.equal(s.contextRelevance,.5);assert.equal(s.contextRelevanceCount,2);assert.equal(s.contextSufficiency,.75);assert.equal(s.contextRecall,.8);assert.equal(s.answerFactuality,.6);assert.equal(s.precisionAtK,.4);
});
test('judge route receives evaluation reference while classifier cannot receive gold IDs',async()=>{
 const event=exampleEvents[0],contexts=event.contexts;let input;
 const {walkthroughJudge}=await import('../public/fixtures.js');
 const response=await handleModelRequest(req({event,contexts,decision}),'judge',async(url,options)=>{const body=JSON.parse(options.body);input=JSON.parse(body.messages[1].content);assert.ok(body.response_format.json_schema.schema.required.includes('context_verdicts'));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(walkthroughJudge(event,contexts,decision))}}]});});
 assert.equal(response.status,200);assert.equal(input.reference_explanation,event.reference_explanation);assert.equal(input.event.analyst_label,undefined);assert.equal(input.event.relevant_context_ids,undefined);assert.equal(classifierInput(event,contexts,'').event.relevant_context_ids,undefined);
 const result=await response.json();assert.equal(result.result.context_relevance,.6);assert.equal(result.result.context_sufficiency,1);
});
