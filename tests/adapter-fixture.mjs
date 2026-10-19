// Local contract fixture; never used by the deployed application.
import http from 'node:http';
import {exampleEvents,walkthroughDecisions} from '../public/fixtures.js';
const server=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:4387');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Content-Type','application/json');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 const url=new URL(req.url,'http://127.0.0.1:4389');
 if(url.pathname==='/v1/events'){
  const sources=(url.searchParams.get('source')||'Zenity,Troj').split(',');
  const events=exampleEvents.map((e,i)=>({...e,decision:{...walkthroughDecisions[i],model:'contract-test-fixture'}})).filter(e=>sources.includes(e.source)).slice(0,Number(url.searchParams.get('limit')||6));
  res.end(JSON.stringify({events,next_cursor:null}));return;
 }
 if(url.pathname==='/v1/retrieve'){
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const event=exampleEvents.find(e=>e.id===body.event_id);res.end(JSON.stringify({contexts:event?.contexts.slice(0,body.top_k)||[]}));return;
 }
 res.writeHead(404);res.end(JSON.stringify({error:'Fixture route not found.'}));
});server.listen(4389,'127.0.0.1',()=>console.log('EMS contract fixture: http://127.0.0.1:4389'));
