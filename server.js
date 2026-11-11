import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { readState, writeState, transact } from './lib/store.js';
import { newState, loadSeed, makeDraft, field, PROFILE_FIELDS, clone, id, now, bump, snapshotHash, value, confirmed, TOPICS } from './lib/model.js';
import { inspect, approvalGate, repairsFor, financials } from './lib/rules.js';
import { aiConfigured, chatCompletion, suggestDraftCopy, transcribe } from './lib/ai.js';
import { demoProvider } from './lib/provider.js';

const publicDir=path.resolve('./public');
const port=Number(process.env.PORT||3000);
const fail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const rate=new Map();
function limit(sessionId,type,max,windowMs) {
  const key=`${sessionId}:${type}`, t=Date.now(), old=rate.get(key)||[];
  const active=old.filter(x=>t-x<windowMs);
  if(active.length>=max) fail('Too many requests. Please retry shortly.',429);
  active.push(t);rate.set(key,active);
}
function sessionId(req,res) {
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ba_session='));
  const existing=cookie?.split('=')[1];
  if(existing && /^[a-f0-9-]{36}$/.test(existing)) return existing;
  const fresh=randomUUID();
  const secure=(req.headers['x-forwarded-proto']==='https'||req.socket.encrypted)?'; Secure':'';
  res.setHeader('Set-Cookie',`ba_session=${fresh}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
  return fresh;
}
async function bodyBuffer(req,max=2_000_000) {
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>max) fail('Upload too large.',413);chunks.push(chunk);}
  return Buffer.concat(chunks);
}
async function bodyJson(req,max) {
  const bytes=await bodyBuffer(req,max);
  try{return JSON.parse(bytes.toString('utf8')||'{}');}catch{fail('Invalid JSON.');}
}
const isNumber=x=>typeof x==='number'&&Number.isFinite(x);
const isText=x=>typeof x==='string'&&x.length<=2000;
function validateProfilePatch(patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)) fail('Invalid profile patch.');
  const out={};
  for(const [key,raw] of Object.entries(patch)) {
    if(!PROFILE_FIELDS.includes(key)) fail(`Unknown field ${key}.`);
    const item=raw&&typeof raw==='object'&&'value' in raw?raw:{value:raw,source:'user_confirmed'};
    const v=item.value;
    if(v!==null&&!isText(v)&&!isNumber(v)&&typeof v!=='boolean'&&
      !(Array.isArray(v)&&v.length<=30&&v.every(isText))) fail(`Invalid ${key}.`);
    if(['price','budgetTotal','budgetDaily','contributionBeforeDiscount','discount','extraFulfilmentCost','acceptableOrders'].includes(key)&&v!==null&&(!isNumber(v)||v<0)) fail(`${key} must be a nonnegative number.`);
    const source=['user_confirmed','extracted_unconfirmed','imported_unconfirmed','unknown'].includes(item.source)?item.source:'user_confirmed';
    out[key]=field(v,source);
  }
  return out;
}
const DRAFT_FIELDS=new Set(['goal','targetRegions','excludedRegions','budgetTotal','budgetDaily','startDate','endDate','scheduleHours','offer','offerSku','discount','minimumOrderText','cta','destination','includedTopics','excludedTopics','format','audienceNote','productPriority','creatives']);
function validateDraftPatch(patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)) fail('Invalid draft patch.');
  const out={};
  for(const [key,v] of Object.entries(patch)) {
    if(!DRAFT_FIELDS.has(key)) fail(`Unknown campaign field ${key}.`);
    if(['budgetTotal','budgetDaily','discount'].includes(key)&&v!==null&&(!isNumber(v)||v<0)) fail(`${key} must be nonnegative.`);
    if(['targetRegions','excludedRegions','includedTopics','excludedTopics'].includes(key)&&(!Array.isArray(v)||v.length>30||!v.every(isText))) fail(`Invalid ${key}.`);
    if(key==='creatives'&&(!Array.isArray(v)||v.length>10||!v.every(c=>c&&isText(c.headline)&&isText(c.description)&&isText(c.language)&&typeof c.approved==='boolean'))) fail('Invalid creative variants.');
    if(!['budgetTotal','budgetDaily','discount','targetRegions','excludedRegions','includedTopics','excludedTopics','creatives'].includes(key)&&v!==null&&!isText(v)) fail(`Invalid ${key}.`);
    out[key]=v;
  }
  return out;
}
function expected(state,input) {if(input.expectedVersion!==undefined&&input.expectedVersion!==state.campaignVersion) fail('This campaign changed in another tab. Reload to see the latest version.',409);}
function audit(state,type,actor,before,after,status='applied',explanation='') {
  state.audit.push({id:id(),at:now(),type,actor,before:clone(before),after:clone(after),status,revision:state.campaignVersion,explanation});
}
function track(state,name) {state.analytics.push({name,at:now(),campaignId:state.campaign?.id||null,version:state.campaignVersion,personaScenario:state.demo,language:state.session.locale,status:state.campaign?.status||'NEW'});}
function parseCsv(text) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted) fail('CSV has an unclosed quoted value.');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  if(!rows.length) fail('CSV is empty.');
  const headers=rows.shift().map((x,i)=>i===0?x.replace(/^\uFEFF/,'').trim():x.trim());
  return rows.map((cells,i)=>Object.fromEntries(headers.map((h,j)=>[h,cells[j]?.trim()||'']))).map((data,i)=>({row:i+2,data}));
}
function dedup(events) {
  const groups=new Map(),uncertain=[];
  for(const event of events) {
    const key=String(event.transactionId||'').trim().toLowerCase();
    if(!key){uncertain.push(event);continue;}
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(event);
  }
  return {originalCount:events.length,knownUniqueTransactions:groups.size,
    duplicateCandidates:[...groups.entries()].filter(([,a])=>a.length>1).map(([transactionId,records])=>({transactionId,records})),
    uncertainRecords:uncertain,groups:[...groups.entries()].map(([transactionId,records])=>({transactionId,records}))};
}
const privateIp=ip=>{
  if(!ip) return true;
  const v=ip.toLowerCase();
  if(v.includes(':')) return v==='::1'||v==='::'||v.startsWith('fc')||v.startsWith('fd')||v.startsWith('fe8')||v.startsWith('fe9')||v.startsWith('fea')||v.startsWith('feb')||v.startsWith('::ffff:');
  const a=v.split('.').map(Number);
  return a[0]===0||a[0]===10||a[0]===127||a[0]>=224||a[0]===169&&a[1]===254||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&a[1]===168||a[0]===100&&a[1]>=64&&a[1]<=127||a[0]===198&&a[1]>=18&&a[1]<=19;
};
async function safeFetchHtml(raw) {
  let url;
  try{url=new URL(raw);}catch{fail('Enter a valid website URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname) fail('Only public HTTP(S) websites are allowed.');
  if(url.port&&!['80','443'].includes(url.port)) fail('Custom ports are not allowed.');
  if(url.hostname==='localhost'||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal')) fail('Private websites are not allowed.');
  const addresses=await dns.lookup(url.hostname,{all:true});
  if(!addresses.length||addresses.some(a=>privateIp(a.address))) fail('Private or unresolved websites are not allowed.');
  const chosen=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
      method:'GET',timeout:8000,headers:{'User-Agent':'BoloAds demo importer/1.0','Accept':'text/html'},
      lookup:(hostname,options,callback)=>callback(null,chosen.address,chosen.family)
    },response=>{
      if(response.statusCode>=300&&response.statusCode<400){response.resume();reject(new Error('Redirects are not followed for safety. Enter the final public URL.'));return;}
      if(response.statusCode!==200){response.resume();reject(new Error(`Website returned ${response.statusCode}.`));return;}
      if(!String(response.headers['content-type']||'').includes('text/html')){response.resume();reject(new Error('Website did not return HTML.'));return;}
      let size=0,data='';response.setEncoding('utf8');
      response.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>500_000){request.destroy(new Error('Website response too large.'));return;}data+=chunk;});
      response.on('end',()=>resolve(data));
    });
    request.on('timeout',()=>request.destroy(new Error('Website timed out.')));
    request.on('error',reject);request.end();
  });
}
function stripHtml(html) {return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
function providerPreview(state) {
  return demoProvider.previewPayload(state.campaign);
}
function report(state) {
  const examples={kirana:{impressions:1400,clicks:32,spend:400},boutique:{impressions:1800,clicks:32,spend:520},
    manufacturer:{impressions:4200,clicks:62,spend:531},stock:{impressions:2100,clicks:27,spend:410}};
  const sample=examples[state.demo]||null;
  return {simulationOnly:true,scenario:state.demo||'none',simulatedPerformance:sample?{
    ...sample,messageStarts:null,qualifiedLeads:null,verifiedOrders:null,
    source:'simulated_example',notice:'Illustrative sample. No live ad data or actual spend.'}:null,
    merchantRecordedOutcomes:state.outcomes,notice:'Merchant records do not establish ad attribution.'};
}
function stateView(state) {return {...state,capabilities:{ai:aiConfigured(),voice:aiConfigured(),urlImport:true},
  finance:state.campaign?financials(state):null,providerPreview:providerPreview(state),conversionAudit:dedup(state.conversionEvents),
  gate:approvalGate(state),topics:TOPICS,report:report(state),
  repairChoices:Object.fromEntries((state.inspection?.results||[]).filter(x=>['WARNING','BLOCKER'].includes(x.state)).map(x=>[x.ruleId,repairsFor(state,x.ruleId)]))};}

async function api(req,res,url,session) {
  let route=url.pathname;const method=req.method;
  const campaignAlias=route.match(/^\/api\/campaigns\/([^/]+)(?:\/([^/]+))?$/);
  if(campaignAlias){
    if(campaignAlias[1]==='draft'&&!campaignAlias[2]) route='/api/draft/generate';
    else {
      const current=await readState(session);
      if(current.campaign?.id!==campaignAlias[1])fail('Campaign not found.',404);
      route=({'': '/api/draft',inspect:'/api/inspect','repair-preview':'/api/repair/preview',
        repairs:'/api/repair/apply',approve:'/api/approve','simulate-launch':'/api/simulate-launch',
        report:'/api/report',outcomes:'/api/outcomes',export:'/api/export'})[campaignAlias[2]||'']||route;
    }
  }
  if(route==='/api/business/import-url')route='/api/import-url';
  const businessAlias=route.match(/^\/api\/business\/([^/]+)$/);
  if(businessAlias){const current=await readState(session);if((current.businessId||session)!==businessAlias[1])fail('Business profile not found.',404);route='/api/profile';}
  if(method==='GET'&&route==='/api/state') return json(res,200,stateView(await readState(session)));
  if(method==='GET'&&route==='/api/report')return json(res,200,report(await readState(session)));
  if(method==='GET'&&route==='/api/export') {
    const {state}=await transact(session,s=>{track(s,'export_downloaded');return null;});
    const report={notice:'This is a simulated campaign. No ad was published or charged.',exportedAt:now(),
      session:{locale:state.session.locale},business:state.profile,campaign:state.campaign,
      campaignVersion:state.campaignVersion,inspection:state.inspection,acknowledgedWarnings:state.acknowledgments||[],
      launch:state.launch,inventory:state.inventory,conversionAudit:dedup(state.conversionEvents),outcomes:state.outcomes,
      scenarios:state.scenarios,audit:state.audit};
    if(url.searchParams.get('format')==='summary') {
      const p=state.profile,c=state.campaign;
      const text=[`BoloAds campaign summary`,`This is a simulated campaign. No ad was published or charged.`,
        `Business: ${p.name?.value||'Unknown'}`,`Offer: ${c?.offer||'Not drafted'}`,
        `Target: ${(c?.targetRegions||[]).join(', ')||'Unknown'}`,`Total cap: ${c?.budgetTotal??'Unknown'} INR`,
        `Daily cap: ${c?.budgetDaily??'Unknown'} INR`,`Dates: ${c?.startDate||'?'} to ${c?.endDate||'?'}`,
        `Inspection: ${state.inspection?.checkedAt||'Not run'}`,
        ...(state.inspection?.results||[]).map(x=>`${x.ruleId} ${x.state}: ${x.message}`),
        `Acknowledged warnings: ${(state.acknowledgments||[]).join(', ')||'None'}`,`Launch ID: ${state.launch?.id||'Not launched'}`].join('\n');
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="boloads-summary.txt"'});res.end(text);return;
    }
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="boloads-campaign.json"'});res.end(JSON.stringify(report,null,2));return;
  }
  if(method==='GET'&&route==='/api/provider/preview') return json(res,200,providerPreview(await readState(session)));
  if(method==='GET'&&route==='/api/conversions/report') {
    const {state}=await transact(session,s=>{track(s,'export_downloaded');return null;});
    const report={notice:'This audit groups only exact normalized transaction IDs. Missing IDs remain uncertain; amount alone is never used to merge records.',
      exportedAt:now(),audit:dedup(state.conversionEvents)};
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="boloads-conversion-audit.json"'});
    res.end(JSON.stringify(report,null,2));return;
  }
  if(method==='POST'&&route==='/api/reset') {
    const input=await bodyJson(req);
    const locale=['en','hi'].includes(input.locale)?input.locale:'en';
    const state=input.seed?loadSeed(session,input.seed,locale):newState(session,locale);
    track(state,input.seed?'demo_profile_loaded':'session_started');
    await writeState(state);return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/session') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{if(['en','hi'].includes(input.locale))s.session.locale=input.locale;if(['basic','advanced'].includes(input.mode))s.session.mode=input.mode;return null;});
    return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/chat') {
    limit(session,'chat',20,60000);
    const input=await bodyJson(req);if(!isText(input.userText)||!input.userText.trim())fail('Enter a message.');
    const state=await readState(session);
    const answer=await chatCompletion(state,input.userText.slice(0,4000),input.locale||state.session.locale);
    const result=await transact(session,s=>{
      s.chat.push({id:id(),role:'user',language:input.locale||s.session.locale,content:input.userText,createdAt:now()});
      s.chat.push({id:id(),role:'assistant',language:answer.language,content:[answer.assistantText,...answer.questions].join('\n'),createdAt:now(),extractedPatch:answer.facts});
      for(const fact of answer.facts) if(s.profile[fact.field]?.source!=='user_confirmed')
        s.profile[fact.field]=field(fact.value,'extracted_unconfirmed');
      audit(s,'ai_extraction','llm',null,answer.facts,'suggested','Facts require merchant confirmation.');
      track(s,'chat_submitted');if(input.transcriptEdited)track(s,'transcript_edited');return answer;
    });
    return json(res,200,{...stateView(result.state),chatResult:answer});
  }
  if(method==='POST'&&route==='/api/audio/transcribe') {
    limit(session,'audio',8,60000);
    const bytes=await bodyBuffer(req,12_000_000);
    const form=await new Request('http://localhost/audio',{method:'POST',headers:{'content-type':req.headers['content-type']||''},body:bytes}).formData();
    const file=form.get('audio');if(!file||typeof file.arrayBuffer!=='function')fail('Audio file missing.');
    if(file.size>10_000_000||file.size<100)fail('Audio must be between 100 bytes and 10 MB.');
    const answer=await transcribe(Buffer.from(await file.arrayBuffer()),file.type,form.get('language'));
    await transact(session,s=>{track(s,'voice_recorded');return null;});
    return json(res,200,answer);
  }
  if(method==='POST'&&route==='/api/import-url') {
    limit(session,'import',5,60000);const input=await bodyJson(req);
    const html=await safeFetchHtml(input.url);
    const title=html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()||'';
    const description=html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)/i)?.[1]||'';
    const details={title:title.slice(0,160),description:description.slice(0,500),excerpt:stripHtml(html).slice(0,600),url:input.url,source:'imported_unconfirmed'};
    const {state}=await transact(session,s=>{audit(s,'website_import','system',null,details,'suggested','Imported text is unconfirmed.');return null;});
    return json(res,200,{...stateView(state),importResult:details});
  }
  if(method==='POST'&&route==='/api/profile') {
    const input=await bodyJson(req),patch=validateProfilePatch(input.patch);
    const {state}=await transact(session,s=>{expected(s,input);const before=Object.fromEntries(Object.keys(patch).map(k=>[k,s.profile[k]]));
      Object.assign(s.profile,patch);s.profileVersion++;bump(s,'merchant','profile_edit',before,patch,'Merchant edited business facts.');
      track(s,'fact_confirmed');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/profile/reject') {
    const input=await bodyJson(req);
    if(!PROFILE_FIELDS.includes(input.field))fail('Unknown profile field.');
    const {state}=await transact(session,s=>{expected(s,input);
      if(!['extracted_unconfirmed','imported_unconfirmed'].includes(s.profile[input.field].source))fail('Only unconfirmed suggestions can be rejected.');
      const before=s.profile[input.field];s.profile[input.field]=field(null,'unknown');s.profileVersion++;
      bump(s,'merchant','suggestion_rejected',{[input.field]:before},{[input.field]:s.profile[input.field]},'Merchant rejected an unconfirmed suggestion.');
      return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/draft/generate') {
    const input=await bodyJson(req);
    const original=await readState(session);
    let aiCopy=null;
    if(aiConfigured()) try{aiCopy=await suggestDraftCopy(original);}catch(error){
      // A validated template remains available when the provider is down.
      aiCopy=null;
    }
    const {state}=await transact(session,s=>{expected(s,input);const before=s.campaign;
      s.campaign=makeDraft(s);
      if(aiCopy){
        s.campaign.creatives[0].headline=aiCopy.headlineA;
        s.campaign.creatives[0].description=aiCopy.descriptionA;
        s.campaign.creatives[1].headline=aiCopy.headlineB;
        s.campaign.creatives[1].description=aiCopy.descriptionB;
        s.campaign.cta=aiCopy.cta;
        s.campaign.includedTopics=aiCopy.topics.map(x=>TOPICS.find(topic=>topic.toLowerCase()===x.toLowerCase())).filter(Boolean);
        s.campaign.source='AI suggested';
      }
      bump(s,'system','draft_generated',before,s.campaign,aiCopy?'AI suggested copy from confirmed facts.':'Validated template draft from saved profile.');
      track(s,'draft_generated');return null;});return json(res,200,stateView(state));
  }
  if(method==='PATCH'&&route==='/api/draft') {
    const input=await bodyJson(req),patch=validateDraftPatch(input.patch);
    const {state}=await transact(session,s=>{expected(s,input);if(!s.campaign)fail('Create a draft first.');
      const before=Object.fromEntries(Object.keys(patch).map(k=>[k,s.campaign[k]]));
      Object.assign(s.campaign,patch);for(const k of Object.keys(patch))s.campaign.confirmedFields[k]=true;
      bump(s,'merchant','campaign_edit',before,patch,'Merchant edited campaign settings.');
      return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/inspect') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);if(!s.campaign)fail('Create a draft first.');
      const prior=s.inspection,rerun=s.inspectionHistory.length>0;s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];
      audit(s,rerun?'inspection_rerun':'inspection_started','system',prior?.counts||null,s.inspection.counts);
      track(s,rerun?'inspection_rerun':'inspection_started');if(s.inspection.counts.WARNING)track(s,'warning_shown');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/repair/preview') {
    const input=await bodyJson(req),state=await readState(session);
    if(!state.campaign)fail('Create a draft first.');
    const choices=repairsFor(state,input.ruleId);
    const option=choices.find(x=>x.id===input.optionId);if(!option)fail('Repair option unavailable.');
    const proposal=clone(state);proposal.campaign={...proposal.campaign,...validateDraftPatch(option.patch)};
    const preview=inspect(proposal,proposal.campaign);
    await transact(session,s=>{track(s,'repair_previewed');return null;});
    return json(res,200,{option,before:state.inspection?.counts||null,after:preview.counts,results:preview.results,
      diff:Object.fromEntries(Object.entries(option.patch).map(([k,v])=>[k,{before:state.campaign[k],after:v}]))});
  }
  if(method==='POST'&&route==='/api/repair/apply') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);if(!s.campaign)fail('Create a draft first.');
      const option=repairsFor(s,input.ruleId).find(x=>x.id===input.optionId);if(!option)fail('Repair option unavailable.');
      const patch=validateDraftPatch(option.patch),before=Object.fromEntries(Object.keys(patch).map(k=>[k,s.campaign[k]]));
      Object.assign(s.campaign,patch);for(const k of Object.keys(patch))s.campaign.confirmedFields[k]=true;
      bump(s,'merchant','repair_applied',before,patch,option.explanation);
      s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];
      audit(s,'inspection_rerun','system',null,s.inspection.counts);
      track(s,'repair_applied');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/ack') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);if(!s.inspection||s.inspection.campaignVersion!==s.campaignVersion)fail('Run inspection first.');
      const warning=s.inspection.results.find(x=>x.ruleId===input.ruleId&&x.state==='WARNING');if(!warning)fail('Only current warnings can be acknowledged.');
      s.acknowledgments=[...new Set([...(s.acknowledgments||[]),input.ruleId])];
      audit(s,'warning_acknowledged','merchant',null,{ruleId:input.ruleId},'acknowledged','Risk accepted, not fixed.');
      track(s,'warning_acknowledged');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/approve') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);const gate=approvalGate(s);if(!gate.ok){track(s,'approval_blocked');fail(gate.reason,409);}
      if(input.consent!==true)fail('Confirm that this is a simulated launch.',409);
      s.campaign.status='APPROVED';s.approval={at:now(),version:s.campaignVersion,hash:snapshotHash(s),
        acknowledgedWarningIds:[...(s.acknowledgments||[])]};
      audit(s,'campaign_approved','merchant',null,s.approval);track(s,'campaign_approved');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/simulate-launch') {
    const {state}=await transact(session,s=>{if(s.launch)return null;
      if(!s.approval||s.approval.version!==s.campaignVersion||s.campaign?.status!=='APPROVED')fail('Approve the current revision first.',409);
      s.launch=demoProvider.simulatePublish(s.campaign);
      s.campaign.status='APPROVED_SIMULATED';audit(s,'simulated_launch_created','system',null,s.launch);
      track(s,'simulated_launch_created');return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/outcomes') {
    const input=await bodyJson(req);
    if(!['qualified_lead','redemption','order','message_start'].includes(input.kind))fail('Invalid outcome kind.');
    if(input.amount!==null&&input.amount!==undefined&&(!isNumber(input.amount)||input.amount<0))fail('Amount must be nonnegative.');
    const {state}=await transact(session,s=>{const event={id:id(),at:now(),date:input.date||now().slice(0,10),kind:input.kind,
      amount:input.amount??null,notes:String(input.notes||'').slice(0,500),merchantVerified:true,source:'merchant_recorded'};
      s.outcomes.push(event);audit(s,'outcome_recorded','merchant',null,event);track(s,'outcome_recorded');return null;});
    return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/inventory/import') {
    const input=await bodyJson(req,1_000_000),rows=parseCsv(String(input.csv||''));const errors=[],items=[],seen=new Set();
    for(const {row,data} of rows){const sku=data.SKU||data.sku,name=data.name||data.Name||sku,quantity=Number(data.quantity??data.Quantity),active=String(data.active??data.Active??'true').toLowerCase();
      if(!sku)errors.push(`Row ${row}: SKU is required.`);
      else if(seen.has(sku.toLowerCase()))errors.push(`Row ${row}: duplicate SKU ${sku}.`);
      else if(!Number.isInteger(quantity)||quantity<0)errors.push(`Row ${row}: quantity must be a nonnegative integer.`);
      else if(!['true','false','1','0','yes','no'].includes(active))errors.push(`Row ${row}: active must be true or false.`);
      else {seen.add(sku.toLowerCase());items.push({sku,name,quantity,active:['true','1','yes'].includes(active),lastUpdated:data.lastUpdated||data.LastUpdated||now().slice(0,10)});}
    }
    if(errors.length)return json(res,422,{errors});
    const {state}=await transact(session,s=>{const before=s.inventory;s.inventory=items;bump(s,'merchant','inventory_import',before,items,'CSV stock register replaced.');
      if(s.campaign){s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];audit(s,'inspection_rerun','system',null,s.inspection.counts);}
      return null;});
    return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/inventory/update') {
    const input=await bodyJson(req);if(!isText(input.sku)||!Number.isInteger(input.quantity)||input.quantity<0)fail('Enter SKU and nonnegative stock quantity.');
    const {state}=await transact(session,s=>{const before=clone(s.inventory);const item=s.inventory.find(x=>x.sku===input.sku);
      if(item){item.quantity=input.quantity;item.active=input.active!==false;item.lastUpdated=now().slice(0,10);}
      else s.inventory.push({sku:input.sku,name:String(input.name||input.sku).slice(0,120),quantity:input.quantity,active:input.active!==false,lastUpdated:now().slice(0,10)});
      bump(s,'merchant','inventory_edit',before,s.inventory,'Manual stock register edit.');
      if(s.campaign){s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];audit(s,'inspection_rerun','system',null,s.inspection.counts);}
      return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/events/import') {
    const input=await bodyJson(req,1_000_000),rows=parseCsv(String(input.csv||''));const errors=[],events=[];
    for(const {row,data} of rows){const transactionId=data.transactionId||data.transaction_id||data.id||'';
      const amount=data.value||data.amount||'';if(amount!==''&&(!Number.isFinite(Number(amount))||Number(amount)<0))errors.push(`Row ${row}: invalid amount.`);
      else events.push({id:id(),transactionId:String(transactionId).trim(),time:data.time||data.timestamp||'',value:amount===''?null:Number(amount),
        source:String(input.source||data.source||'uploaded').slice(0,100),eventType:data.eventType||data.event_type||'order',row});}
    if(errors.length)return json(res,422,{errors});
    const {state}=await transact(session,s=>{s.conversionEvents.push(...events);audit(s,'conversion_csv_import','merchant',null,{source:input.source,count:events.length});return null;});
    return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/scenarios') {
    const input=await bodyJson(req);const patch=validateDraftPatch(input.patch||{});if(!isText(input.name)||!input.name.trim())fail('Name the scenario.');
    const assumption=input.assumptions?.contributionBeforeDiscount;
    const extraAssumption=input.assumptions?.extraFulfilmentCost;
    if(assumption!==null&&assumption!==undefined&&(!isNumber(assumption)||assumption<0))fail('Scenario contribution must be nonnegative.');
    if(extraAssumption!==null&&extraAssumption!==undefined&&(!isNumber(extraAssumption)||extraAssumption<0))fail('Scenario extra cost must be nonnegative.');
    const {state}=await transact(session,s=>{if(!s.campaign)fail('Create a draft first.');
      const scenario={id:input.id||id(),name:input.name.trim().slice(0,80),baseVersion:s.campaignVersion,
        draft:{...clone(s.campaign),...patch},assumptions:{contributionBeforeDiscount:assumption??null,extraFulfilmentCost:extraAssumption??null},createdAt:now()};
      for(const k of Object.keys(patch))scenario.draft.confirmedFields[k]=true;
      const trial=clone(s);
      if(assumption!==null&&assumption!==undefined){trial.profile.contributionBeforeDiscount=field(assumption,'user_confirmed');trial.profile.contributionBasisConfirmed=field(true,'user_confirmed');}
      if(extraAssumption!==null&&extraAssumption!==undefined)trial.profile.extraFulfilmentCost=field(extraAssumption,'user_confirmed');
      scenario.inspection=inspect(trial,scenario.draft);scenario.finance=financials(trial,scenario.draft);
      const index=s.scenarios.findIndex(x=>x.id===scenario.id);if(index>=0)s.scenarios[index]=scenario;else s.scenarios.push(scenario);
      audit(s,'scenario_saved','merchant',null,{id:scenario.id,name:scenario.name},'suggested','Scenario does not change active draft.');return null;});
    return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/scenarios/apply') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);const scenario=s.scenarios.find(x=>x.id===input.id);if(!scenario)fail('Scenario not found.');
      const before={campaign:clone(s.campaign),contributionBeforeDiscount:clone(s.profile.contributionBeforeDiscount),
        contributionBasisConfirmed:clone(s.profile.contributionBasisConfirmed),extraFulfilmentCost:clone(s.profile.extraFulfilmentCost)};
      s.campaign=clone(scenario.draft);s.campaign.id=before.campaign.id;
      if(scenario.assumptions?.contributionBeforeDiscount!==null&&scenario.assumptions?.contributionBeforeDiscount!==undefined){
        s.profile.contributionBeforeDiscount=field(scenario.assumptions.contributionBeforeDiscount,'user_confirmed');
        s.profile.contributionBasisConfirmed=field(true,'user_confirmed');s.profileVersion++;
      }
      if(scenario.assumptions?.extraFulfilmentCost!==null&&scenario.assumptions?.extraFulfilmentCost!==undefined){
        s.profile.extraFulfilmentCost=field(scenario.assumptions.extraFulfilmentCost,'user_confirmed');s.profileVersion++;
      }
      bump(s,'merchant','scenario_applied',before,{campaign:s.campaign,contributionBeforeDiscount:s.profile.contributionBeforeDiscount,
        contributionBasisConfirmed:s.profile.contributionBasisConfirmed,extraFulfilmentCost:s.profile.extraFulfilmentCost},`Applied scenario ${scenario.name}.`);
      s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/ledger/revert') {
    const input=await bodyJson(req);
    const {state}=await transact(session,s=>{expected(s,input);const event=s.audit.find(x=>x.id===input.eventId);
      if(!event||!['campaign_edit','repair_applied','scenario_applied','profile_edit'].includes(event.type))fail('This change cannot be reverted.');
      if(event.type==='profile_edit'){const previous=Object.fromEntries(Object.keys(event.before||{}).map(k=>[k,s.profile[k]]));Object.assign(s.profile,clone(event.before));s.profileVersion++;bump(s,'merchant','change_reverted',previous,event.before,`Reverted ${event.type}.`);}
      else if(event.type==='scenario_applied'){
        const previous={campaign:clone(s.campaign),contributionBeforeDiscount:clone(s.profile.contributionBeforeDiscount),
          contributionBasisConfirmed:clone(s.profile.contributionBasisConfirmed),extraFulfilmentCost:clone(s.profile.extraFulfilmentCost)};
        s.campaign=clone(event.before.campaign);s.profile.contributionBeforeDiscount=clone(event.before.contributionBeforeDiscount);
        s.profile.contributionBasisConfirmed=clone(event.before.contributionBasisConfirmed);
        s.profile.extraFulfilmentCost=clone(event.before.extraFulfilmentCost);s.profileVersion++;
        bump(s,'merchant','change_reverted',previous,event.before,'Reverted scenario application.');
      } else {const keys=Object.keys(event.before||{});const previous=Object.fromEntries(keys.map(k=>[k,s.campaign[k]]));
        Object.assign(s.campaign,clone(event.before));bump(s,'merchant','change_reverted',previous,event.before,`Reverted ${event.type}.`);}
      s.inspection=inspect(s);s.inspectionHistory.push(s.inspection);s.acknowledgments=[];return null;});return json(res,200,stateView(state));
  }
  if(method==='POST'&&route==='/api/media') {
    const input=await bodyJson(req,3_000_000);
    if(typeof input.data!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(input.data)||input.data.length>2_700_000)fail('Use a PNG, JPEG or WebP image under 2 MB.');
    const {state}=await transact(session,s=>{s.media=input.data;audit(s,'media_uploaded','merchant',null,{type:input.data.slice(0,30)});return null;});return json(res,200,stateView(state));
  }
  fail('Endpoint not found.',404);
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const session=sessionId(req,res);
    if(url.pathname.startsWith('/api/')) return await api(req,res,url,session);
    if(req.method!=='GET')fail('Method not allowed.',405);
    let file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    file=path.normalize(file);
    if(file.startsWith('..')||path.isAbsolute(file))fail('Not found.',404);
    const full=path.join(publicDir,file);
    if(!full.startsWith(publicDir))fail('Not found.',404);
    const bytes=await fs.readFile(full);
    res.writeHead(200,{'Content-Type':contentTypes[path.extname(full)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(bytes);
  } catch(error) {
    if(req.url?.startsWith('/api/')) json(res,error.status||500,{error:error.message||'Server error.'});
    else {res.writeHead(error.code==='ENOENT'?404:error.status||500);res.end('Not found');}
  }
});
if(process.env.NODE_ENV!=='test')server.listen(port,()=>console.log(`BoloAds listening on http://localhost:${port}`));
export { server, dedup, parseCsv, providerPreview };
