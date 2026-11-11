import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSeed, newState, field } from '../lib/model.js';
import { inspect, financials, approvalGate } from '../lib/rules.js';
import { planFollowups } from '../lib/ai.js';

test('Chat follows a no-delivery answer without repeating earlier questions',()=>{
  const state=newState('chat-regression');
  state.profile.city=field('Aliganj','extracted_unconfirmed');
  state.profile.budgetTotal=field(2000,'extracted_unconfirmed');
  state.chat=[
    {role:'user',content:'Meri kirana dukaan Aliganj mein hai; weekend ₹2000 ka ad chahiye'},
    {role:'assistant',content:'Which areas can you serve? What offer would you like to advertise?',questionKeys:['serviceRegions','offer']}
  ];
  const followups=planFollowups(state,[],'I cannot deliver; customers must visit the store','en');
  assert.equal(followups.some(x=>x.key==='serviceRegions'||x.key==='offer'),false);
  assert.equal(followups[0]?.key,'campaignRegions');
});

test('Chat treats extracted facts as known and asks each missing question once',()=>{
  const state=newState('chat-extracted');
  state.profile.offer=field('Weekend offer','extracted_unconfirmed');
  state.profile.budgetTotal=field(2000,'extracted_unconfirmed');
  state.chat=[{role:'assistant',content:'Which areas can you serve?',questionKeys:['serviceRegions']}];
  const followups=planFollowups(state,[],'not sure','en');
  assert.equal(followups.some(x=>['serviceRegions','offer','budgetTotal'].includes(x.key)),false);
});

test('Kirana calculation uses confirmed contribution and exact break-even formula',()=>{
  const state=loadSeed('00000000-0000-0000-0000-000000000001','kirana');
  const f=financials(state);
  assert.equal(f.post,20);
  assert.equal(f.breakEven,100);
  state.profile.contributionBasisConfirmed=field(null,'unknown');
  assert.equal(financials(state).state,'UNKNOWN');
});

test('Geography warning requires explicit service evidence and reruns after repair',()=>{
  const state=loadSeed('00000000-0000-0000-0000-000000000002','manufacturer');
  assert.equal(inspect(state).results.find(x=>x.ruleId==='GEO_01').state,'WARNING');
  state.campaign.targetRegions=['Gujarat'];
  assert.equal(inspect(state).results.find(x=>x.ruleId==='GEO_01').state,'PASS');
  state.profile.serviceRegions=field(null,'unknown');
  assert.equal(inspect(state).results.find(x=>x.ruleId==='GEO_01').state,'UNKNOWN');
});

test('Hard blockers and unacknowledged warnings stop approval',()=>{
  const state=loadSeed('00000000-0000-0000-0000-000000000003','boutique');
  state.inspection=inspect(state);
  assert.equal(approvalGate(state).ok,false);
  state.acknowledgments=['GEO_01','OPS_02'];
  assert.equal(approvalGate(state).ok,true);
  state.campaign.budgetTotal=null;
  state.campaignVersion++;
  assert.equal(approvalGate(state).ok,false);
  state.inspection=inspect(state);
  assert.equal(state.inspection.results.find(x=>x.ruleId==='CFG_01').state,'BLOCKER');
  assert.equal(approvalGate(state).ok,false);
});

test('HTTP flow persists repaired campaign and idempotent simulated launch',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'boloads-test-'));
  process.env.DATA_DIR=directory;process.env.NODE_ENV='test';
  const {server}=await import('../server.js');
  await new Promise(resolve=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  const call=async(url,method='GET',body)=>{
    const response=await fetch(base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,data:await response.json()};
  };
  try{
    let r=await call('/api/reset','POST',{seed:'manufacturer'});assert.equal(r.status,200);
    r=await call('/api/inspect','POST',{expectedVersion:r.data.campaignVersion});
    assert.equal(r.data.inspection.results.find(x=>x.ruleId==='GEO_01').state,'WARNING');
    r=await call('/api/repair/apply','POST',{ruleId:'GEO_01',optionId:'GEO_01_0',expectedVersion:r.data.campaignVersion});
    assert.equal(r.status,200);
    assert.equal(r.data.inspection.results.find(x=>x.ruleId==='GEO_01').state,'PASS');
    const current=r.data.campaignVersion;
    r=await call('/api/approve','POST',{consent:true,expectedVersion:current});
    assert.equal(r.status,200);
    r=await call('/api/simulate-launch','POST',{});const launchId=r.data.launch.id;
    assert.equal(r.data.launch.status,'APPROVED_SIMULATED');
    r=await call('/api/simulate-launch','POST',{});assert.equal(r.data.launch.id,launchId);
    r=await call('/api/state');assert.equal(r.data.launch.id,launchId);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});

test('CSV stock, conversion deduplication and independent scenarios work through HTTP',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'boloads-data-test-'));
  process.env.DATA_DIR=directory;process.env.NODE_ENV='test';
  const {server}=await import('../server.js');
  await new Promise(resolve=>server.listen(0,resolve));
  const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const call=async(url,method='GET',body)=>{
    const response=await fetch(base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    return {status:response.status,data:await response.json()};
  };
  try{
    let r=await call('/api/reset','POST',{seed:'stock'});
    r=await call('/api/inspect','POST',{expectedVersion:r.data.campaignVersion});
    assert.equal(r.data.inspection.results.find(x=>x.ruleId==='OPS_01').state,'WARNING');
    r=await call('/api/inventory/import','POST',{csv:'SKU,name,quantity,active,lastUpdated\nORG-01,Storage organizer,7,true,2026-11-12'});
    assert.equal(r.status,200);
    assert.equal(r.data.inspection.results.find(x=>x.ruleId==='OPS_01').state,'WARNING'); // profile still says unavailable
    r=await call('/api/profile','POST',{patch:{availability:{value:'available',source:'user_confirmed'}},expectedVersion:r.data.campaignVersion});
    r=await call('/api/inspect','POST',{expectedVersion:r.data.campaignVersion});
    assert.equal(r.data.inspection.results.find(x=>x.ruleId==='OPS_01').state,'PASS');
    r=await call('/api/events/import','POST',{source:'GA4',csv:'transactionId,time,value,eventType\nA-1,2026-11-12T10:00:00Z,999,order\n,2026-11-12T11:00:00Z,999,order'});
    r=await call('/api/events/import','POST',{source:'Shop',csv:'transactionId,time,value,eventType\na-1,2026-11-12T10:01:00Z,999,order\n,2026-11-12T11:01:00Z,999,order'});
    assert.equal(r.data.conversionAudit.originalCount,4);
    assert.equal(r.data.conversionAudit.knownUniqueTransactions,1);
    assert.equal(r.data.conversionAudit.duplicateCandidates.length,1);
    assert.equal(r.data.conversionAudit.uncertainRecords.length,2);
    r=await call('/api/scenarios','POST',{name:'A',patch:{discount:20},assumptions:{contributionBeforeDiscount:120,extraFulfilmentCost:0}});
    const scenarioA=r.data.scenarios[0];
    r=await call('/api/scenarios','POST',{name:'B',patch:{discount:40},assumptions:{contributionBeforeDiscount:150,extraFulfilmentCost:0}});
    assert.equal(r.data.scenarios[0].finance.post,100);
    assert.equal(r.data.scenarios[1].finance.post,110);
    r=await call('/api/scenarios','POST',{id:r.data.scenarios[1].id,name:'B',patch:{discount:40},assumptions:{contributionBeforeDiscount:200,extraFulfilmentCost:0}});
    assert.equal(r.data.scenarios[0].finance.post,100);
    assert.equal(r.data.scenarios[1].finance.post,160);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
