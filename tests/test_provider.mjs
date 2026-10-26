// Transport integration for v2. Does not claim real browser UI verification.
import assert from 'node:assert/strict';
const base=process.argv[2]||'http://127.0.0.1:8765/';
const useDist=process.argv[3]==='dist';
const nativeFetch=globalThis.fetch, calls=[];
globalThis.fetch=(url,options)=>{const u=new URL(url,base);calls.push(u.pathname);return nativeFetch(u,options);};
const catalog=await(await fetch('./data/box54.json')).json();
const {call,getRuntime}=await import(new URL(useDist?'../dist/api.mjs':'../public/api.mjs',import.meta.url).href);
const ids=catalog.items.map(i=>i.id), observed=['54-r3-e1','54-r7-e2'];
const latent=ids.filter(i=>!observed.includes(i));
const values=Object.fromEntries(ids.map(i=>[i,0]));
[200,200,120,120,120,120,0,0,0,0,-60,-60].forEach((v,j)=>values[latent[j]]=v);
const input={session_id:'synthetic-v2-provider',box_id:'54.0',initial_remaining:5,mode:'preference',
 values,cost:25,budget:null,packing_ack:true,valuation_meta:{kind:'explicit_values'},
 target_ids:latent.slice(0,2),mechanism:{kind:'random_removal'}};
let state=await call({op:'create',input},catalog);
assert.equal(state.schema_version,2);
for(const [j,item] of observed.entries())state=await call({op:'record',state,event_id:`draw-${j}`,item_id:item},catalog);
const snapshot=JSON.stringify(state);
const a=await call({op:'recommend',state},catalog);
assert.equal(JSON.stringify(state),snapshot);
assert.deepEqual([a.actual_remaining,a.latent_count,a.max_future_draws],[3,12,3]);
const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-8,`${x} vs ${y}`);
near(a.next_ev,190/3);near(a.next_net,115/3);near(a.optimal_value,115);
near(a.risk.next_target_probability,1/6);near(a.risk.remaining_zero_target_probability,6/11);
near(a.risk.fixed_all_remaining_hit_probability,5/11);near(a.risk.expected_additional_spend,75);
const strategic=[];
for(const limit of [1,2]){
 const s=await call({op:'create',input:{...input,initial_remaining:4,mechanism:{kind:'target_stop',target_ids:latent.slice(0,2),hit_limit:limit,max_draws:14}}},catalog);
 const b=await call({op:'recommend',state:s},catalog);
 near(b.risk.next_target_probability,limit===1?1/4:0);
 near(b.risk.remaining_zero_target_probability,limit===1?0:1);
 strategic.push({hit_limit:limit,probability_n:b.stage1.probability_n,next_hit:b.risk.next_target_probability,zero:b.risk.remaining_zero_target_probability});
}
const restored=await call({op:'restore',payload:JSON.stringify(state)},catalog);
assert.deepEqual(restored,state);
const undone=await call({op:'undo',state,event_id:'draw-1'},catalog);
assert.deepEqual(await call({op:'record',state:undone,event_id:'draw-1',item_id:observed[1]},catalog),undone);
const runtime=await getRuntime();
if(runtime.compute==='client')assert.ok(!calls.includes('/api/dispatch'));
console.log(JSON.stringify({tested:'v2 API/provider, not browser visual',compute:runtime.compute,
 model:a.model_version,actual:a.actual_remaining,latent:a.latent_count,next_ev:a.next_ev,next_net:a.next_net,
 optimal_value:a.optimal_value,zero_target:a.risk.remaining_zero_target_probability,
 expected_spend:a.risk.expected_additional_spend,strategic,api_requests:calls.filter(p=>p==='/api/dispatch').length}));
