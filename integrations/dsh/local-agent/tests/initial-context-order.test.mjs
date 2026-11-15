// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderInitialContext,apply} from '../initial-context-order.mjs';
const m=(kind,text,plugin)=>({role:'user',content:[{type:'text',text}],source:{kind,...plugin?{plugin}:{}}});
const goal=m('user','REAL TASK'),rules=m('agent-instructions','RULES'),skills=m('skill-catalog','CATALOG'),policy=m('plugin','POLICY','@deepseek-ai/dsh-system-prompt');
test('initial native context precedes real task without adding or rewriting a byte',()=>{
 const before=[goal,rules,policy,skills],snapshot=structuredClone(before);
 const after=orderInitialContext(before);
 assert.deepEqual(after,[rules,policy,skills,goal]);assert.deepEqual(before,snapshot);
 assert.deepEqual(new Set(after),new Set(before));assert.equal(orderInitialContext(after),after);
});
test('multiple real pending user messages retain order',()=>{
 const second=m('user','SECOND TASK');assert.deepEqual(orderInitialContext([goal,second,skills]),[skills,goal,second]);
});
test('images, tool results, unknown provenance and system messages remain untouched',()=>{
 for(const input of [[goal,{...skills,content:[{type:'image'}]}],[goal,{role:'user',content:[{type:'tool-result'}]}],[goal,m('plugin','unknown','other')],[{role:'system',content:[]},goal,skills],[rules,skills]])assert.equal(orderInitialContext(input),input);
});
test('existing requests, cancellation, rejection and other providers never reorder',async()=>{
 let handler;apply({on:(_,fn)=>{handler=fn},sessionProjections:{stateOf:()=>({})}});
 const base={messages:[goal,skills],kind:'enter'};
 for(const [provider,header,aborted,kind] of [['other',undefined,false,'enter'],['ninfer-local',{},false,'enter'],['ninfer-local',undefined,true,'enter'],['ninfer-local',undefined,false,'reject']]){
  const decision={...base,kind};const result=await handler({agent:{options:{provider},session:{requestHeader:()=>header}},signal:{aborted}},async()=>decision);assert.equal(result,decision);
 }
 const result=await handler({agent:{options:{provider:'ninfer-local'},session:{header:{agentPreset:'ninfer-local'},requestHeader:()=>undefined}},signal:{aborted:false}},async()=>base);assert.deepEqual(result.messages,[skills,goal]);
});

test('unknown or other preset and active/wanted plan never reorder', async()=>{
 for(const [preset,plan] of [[undefined,{}],['standard',{}],['ninfer-local',{active:true}],['ninfer-local',{wanted:true}]]){
  let handler;apply({on:(_,fn)=>{handler=fn},sessionProjections:{stateOf:()=>plan}});
  const decision={kind:'enter',messages:[goal,skills]};
  const result=await handler({agent:{options:{provider:'ninfer-local'},session:{header:{agentPreset:preset},requestHeader:()=>undefined}},signal:{aborted:false}},async()=>decision);
  assert.equal(result,decision);
 }
});
