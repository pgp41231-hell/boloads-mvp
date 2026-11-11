import { confirmed, value, snapshotHash } from './model.js';

export const RULE_VERSION = '1.0.0';
const result = (ruleId, category, state, message, fields=[], evidence={}, formula=null, remedies=[]) => ({
  ruleId, category, state, severity:state, message, fieldPaths:fields,
  evidenceValues:evidence, formula, confidenceNote:'Deterministic check on saved inputs; merchant facts are self reported.',
  remedies, ruleVersion:RULE_VERSION
});
const n = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const list = x => Array.isArray(x) ? x.map(v=>String(v).trim()).filter(Boolean) : [];
const norm = x => String(x||'').trim().toLowerCase();
const leadGoal = x => ['qualified_leads','leads','messages','calls'].includes(x);
const hours = s => {
  const m = String(s||'').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const a=+m[1]*60 + +m[2], b=+m[3]*60 + +m[4];
  return a<b && b<=1440 ? [a,b] : null;
};
const includesRegion = (target, served) => {
  const t=norm(target), s=norm(served);
  return s==='india' || t===s;
};
export function financials(state, draft=state.campaign) {
  const contribution=n(confirmed(state,'contributionBeforeDiscount'));
  const basis=confirmed(state,'contributionBasisConfirmed') === true;
  const discount=n(draft?.discount ?? confirmed(state,'discount'));
  const extra=n(confirmed(state,'extraFulfilmentCost'));
  const budget=n(draft?.budgetTotal);
  if (contribution===null || discount===null || extra===null || !basis || draft?.confirmedFields?.discount!==true) return {state:'UNKNOWN',reason:'Confirm contribution before discount, discount and any extra variable fulfilment cost (enter 0 if none).'};
  const post=contribution-discount-extra;
  return {state:'CALCULATED',contribution,discount,extra,budget,post,
    breakEven:post>0 && budget!==null ? Math.ceil(budget/post) : null,
    formula:'Post-offer contribution = contribution before discount − discount − extra variable fulfilment cost; break-even incremental orders = ceil(total ad spend ÷ post-offer contribution).'};
}

export function inspect(state, draft=state.campaign, options={}) {
  if (!draft) throw new Error('Create a draft first');
  const out=[];
  const add=(...args)=>out.push(result(...args));
  const budget=n(draft.budgetTotal), daily=n(draft.budgetDaily);
  const today=options.today || new Date().toISOString().slice(0,10);
  const datesValid=typeof draft.startDate==='string' && typeof draft.endDate==='string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(draft.endDate) &&
    draft.startDate>=today && draft.endDate>=draft.startDate &&
    !Number.isNaN(Date.parse(draft.startDate)) && !Number.isNaN(Date.parse(draft.endDate));
  const capValid=budget!==null && budget>0 && daily!==null && daily>0 && daily<=budget;
  const targetValid=list(draft.targetRegions).length>0;
  add('CFG_01','Configuration',capValid&&datesValid&&targetValid?'PASS':'BLOCKER',
    capValid&&datesValid&&targetValid?'Budget caps, dates and target area are valid.':'Enter a target area, valid future dates and positive total/daily caps; daily cap cannot exceed total cap.',
    ['campaign.budgetTotal','campaign.budgetDaily','campaign.startDate','campaign.endDate','campaign.targetRegions'],
    {budgetTotal:budget,budgetDaily:daily,startDate:draft.startDate,endDate:draft.endDate},null,['Set budget and dates']);

  const target=list(draft.targetRegions), served=list(confirmed(state,'serviceRegions'));
  const unknownService=served.length===0 || draft.confirmedFields?.targetRegions!==true;
  const national=target.some(x=>norm(x)==='india' || norm(x)==='nationwide');
  const mismatched=unknownService?[]:target.filter(t=>national ? !served.some(s=>norm(s)==='india') : !served.some(s=>includesRegion(t,s)));
  add('GEO_01','Geography',unknownService?'UNKNOWN':mismatched.length?'WARNING':'PASS',
    unknownService?'Confirm where you can serve customers before evaluating targeting.':mismatched.length?
      `Targeting ${mismatched.join(', ')} exceeds the confirmed service area (${served.join(', ')}). Distant orders may still work if order economics support them.`:
      'Targeting fits the confirmed service area.',
    ['campaign.targetRegions','profile.serviceRegions'],{target,served,mismatched},null,
    ['Narrow targeting','Qualify remote orders','Keep and acknowledge']);
  add('GEO_02','Geography',national&&unknownService?'UNKNOWN':'PASS',
    national&&unknownService?'National targeting needs a confirmed service footprint.':'No unresolved national footprint question.',
    ['campaign.targetRegions','profile.serviceRegions'],{national,served},null,['Confirm service area']);

  const fin=financials(state,draft);
  add('FIN_03','Financial',fin.state==='UNKNOWN'?'UNKNOWN':'PASS',
    fin.state==='UNKNOWN'?fin.reason:'Contribution basis confirmed.',
    ['profile.contributionBeforeDiscount','profile.contributionBasisConfirmed','campaign.discount'],
    fin.state==='UNKNOWN'?{}:{contribution:fin.contribution,discount:fin.discount,extra:fin.extra},null,['Confirm contribution basis']);
  add('FIN_01','Financial',fin.state==='UNKNOWN'?'UNKNOWN':fin.post<=0?'WARNING':'PASS',
    fin.state==='UNKNOWN'?'No break-even figure without confirmed contribution and discount.':
      fin.post<=0?'Offer loses money per incremental order before ad cost.':
      `Post-offer contribution is ₹${fin.post.toFixed(2)} per qualifying order. Break-even is ${fin.breakEven ?? 'unknown'} incremental qualifying orders at the total cap; this is not a sales prediction.`,
    ['profile.contributionBeforeDiscount','campaign.discount','profile.extraFulfilmentCost','campaign.budgetTotal'],
    fin.state==='UNKNOWN'?{}:{contribution:fin.contribution,discount:fin.discount,extra:fin.extra,post:fin.post,budget:fin.budget,breakEven:fin.breakEven},
    fin.state==='UNKNOWN'?null:fin.formula,['Reduce discount','Reduce test budget','Keep and acknowledge']);
  const threshold=n(confirmed(state,'acceptableOrders'));
  add('FIN_02','Financial',fin.state==='UNKNOWN'||threshold===null||fin.breakEven===null?'UNKNOWN':fin.breakEven>threshold?'WARNING':'PASS',
    threshold===null?'No merchant-defined acceptable order threshold was supplied.':fin.state==='UNKNOWN'?'Need confirmed contribution first.':
      fin.breakEven!==null&&fin.breakEven>threshold?`Break-even ${fin.breakEven} orders exceeds your acceptable ${threshold} incremental orders.`:'Break-even does not exceed your stated threshold.',
    ['profile.acceptableOrders','campaign.budgetTotal'],{threshold,breakEven:fin.breakEven??null},
    fin.state==='CALCULATED'?fin.formula:null,['Reduce budget','Revise offer','Keep and acknowledge']);

  const sku=norm(draft.offerSku), stock=state.inventory.find(x=>norm(x.sku)===sku);
  const availability=confirmed(state,'availability');
  const unavailable=availability==='unavailable'||(sku && stock && (!stock.active || stock.quantity===0));
  add('OPS_01','Operations',unavailable?'WARNING':!sku&&availability===null?'UNKNOWN':'PASS',
    unavailable?'The promoted item is marked unavailable. Confirm stock before spending.':
      !sku&&availability===null?'Availability has not been confirmed.':'No confirmed stock conflict.',
    ['profile.availability','campaign.offerSku','inventory'],{availability,sku,stock:stock||null},null,
    ['Choose available SKU','Update stock','Keep and acknowledge']);
  const response=hours(confirmed(state,'responseHours')), schedule=hours(draft.scheduleHours);
  const outside=leadGoal(draft.goal)&&response && (draft.scheduleHours==='all_day'||(schedule&&(schedule[0]<response[0]||schedule[1]>response[1])));
  add('OPS_02','Operations',outside?'WARNING':leadGoal(draft.goal)&&!response?'UNKNOWN':'PASS',
    outside?'Lead ads may run beyond staffed response hours. Explain after-hours handling or narrow the schedule.':
      leadGoal(draft.goal)&&!response?'Staffed response hours are unknown.':'Schedule and response hours do not conflict.',
    ['campaign.scheduleHours','profile.responseHours'],{schedule:draft.scheduleHours,response:confirmed(state,'responseHours')},null,
    ['Match staffed hours','Add after-hours follow-up','Keep and acknowledge']);
  const moq=confirmed(state,'minimumOrder');
  add('OPS_03','Operations',moq&&!draft.minimumOrderText?'SUGGESTION':'PASS',
    moq&&!draft.minimumOrderText?'Mention your minimum order to qualify enquiries.':'Minimum order qualification is addressed or not specified.',
    ['profile.minimumOrder','campaign.minimumOrderText'],{minimumOrder:moq},null,['Add minimum order text']);

  const confirmedDiscount=draft.confirmedFields?.discount?n(draft.discount):n(confirmed(state,'discount'));
  const copy=Array.isArray(draft.creatives)?draft.creatives.map(c=>`${c.headline} ${c.description}`).join(' '):'';
  const amounts=[...copy.matchAll(/(?:₹|rs\.?\s*)(\d+(?:\.\d+)?)\s*(?:off|discount)/gi)].map(x=>+x[1]);
  const copyConflict=confirmedDiscount!==null && amounts.some(a=>a!==confirmedDiscount);
  add('COPY_01','Creative',copyConflict?'WARNING':'PASS',
    copyConflict?'Creative mentions a discount different from the confirmed offer.':'No conflicting numeric discount found in copy.',
    ['campaign.creatives','profile.discount'],{copyDiscounts:amounts,confirmedDiscount},null,
    ['Update creative','Confirm offer','Keep and acknowledge']);
  const tracking=confirmed(state,'orderTracking');
  add('TRACK_01','Measurement',draft.goal==='orders'&&(!tracking||tracking==='clicks_only')?'WARNING':'PASS',
    draft.goal==='orders'&&(!tracking||tracking==='clicks_only')?'Orders are the goal, but only clicks or no order method are tracked.':'Outcome method is defined for this goal.',
    ['campaign.goal','profile.orderTracking'],{goal:draft.goal,tracking},null,['Record orders manually','Keep and acknowledge']);
  const pending=state.proposals.some(p=>p.status==='pending'&&p.consequential);
  add('CTRL_02','Control',pending?'BLOCKER':'PASS',pending?'A consequential AI proposal needs acceptance or rejection.':'No consequential AI proposal is pending.',
    ['proposals'],{pending},null,['Review proposal']);
  const risky=/guaranteed|100% cure|instant profit|risk.free|guarantee/i.test(copy);
  add('POL_01','Creative',risky?'WARNING':'PASS',risky?'Possible restricted or unsupported claim. Illustrative check only; no platform policy approval.':'No simple claim-risk keyword found. Illustrative check only.',
    ['campaign.creatives'],{matched:risky},null,['Edit claim','Keep and acknowledge']);
  const conflict=list(draft.includedTopics).filter(t=>list(draft.excludedTopics).some(x=>norm(x)===norm(t)));
  add('CTX_01','Context',conflict.length?'SUGGESTION':'PASS',conflict.length?'A chosen exclusion overrides a suggested topic.':'Context choices do not conflict.',
    ['campaign.includedTopics','campaign.excludedTopics'],{conflict},null,['Remove included topic']);
  const counts={BLOCKER:0,WARNING:0,SUGGESTION:0,UNKNOWN:0,PASS:0};
  for(const x of out) counts[x.state]++;
  return {id:crypto.randomUUID(),checkedAt:new Date().toISOString(),campaignVersion:state.campaignVersion,
    inputHash:snapshotHash(state),ruleVersion:RULE_VERSION,results:out,counts};
}

export function approvalGate(state) {
  if (!state.campaign) return {ok:false,reason:'Create a campaign draft first.'};
  if (!state.inspection || state.inspection.campaignVersion!==state.campaignVersion ||
      state.inspection.inputHash!==snapshotHash(state)) return {ok:false,reason:'Campaign changed. Run inspection again.'};
  const blockers=state.inspection.results.filter(x=>x.state==='BLOCKER');
  if(blockers.length) return {ok:false,reason:`Resolve ${blockers.length} blocker(s) before approval.`};
  const warnings=state.inspection.results.filter(x=>x.state==='WARNING').map(x=>x.ruleId);
  const missing=warnings.filter(x=>!state.acknowledgments?.includes(x));
  if(missing.length) return {ok:false,reason:`Acknowledge warnings: ${missing.join(', ')}`};
  return {ok:true,reason:'Ready for simulated approval.'};
}

export function repairsFor(state, ruleId) {
  const c=state.campaign;
  if(!c) return [];
  const service=list(confirmed(state,'serviceRegions'));
  const all={
    GEO_01:[
      {label:'Narrow to service area',explanation:'Target only your confirmed service regions.',patch:{targetRegions:service}},
      {label:'Qualify remote orders',explanation:'Keep reach but add the merchant minimum order to the enquiry.',patch:{minimumOrderText:confirmed(state,'minimumOrder')||'Please confirm order size before quoting.'}}
    ],
    FIN_01:[
      {label:'Reduce discount',explanation:'Recalculate with a lower offer amount you choose.',patch:{discount:Math.max(0,Number(c.discount||0)-25)}},
      {label:'Smaller test cap',explanation:'Limit spend while learning; negative contribution remains a risk.',patch:{budgetTotal:Math.max(100,Math.floor(Number(c.budgetTotal||1000)/2)),budgetDaily:Math.min(Number(c.budgetDaily||100),Math.max(100,Math.floor(Number(c.budgetTotal||1000)/2)))}}
    ],
    FIN_02:[
      {label:'Lower test budget',explanation:'Reduce required break-even orders.',patch:{budgetTotal:Math.max(100,Math.floor(Number(c.budgetTotal||1000)/2))}},
      {label:'Reduce discount',explanation:'Increase contribution per qualifying order.',patch:{discount:Math.max(0,Number(c.discount||0)-25)}}
    ],
    OPS_01:[
      {label:'Pause this SKU',explanation:'Remove the unavailable SKU from this draft.',patch:{offerSku:null}},
      {label:'Change schedule',explanation:'Move start one week later; confirm stock before approval.',patch:{startDate:new Date(Date.now()+7*86400000).toISOString().slice(0,10),endDate:new Date(Date.now()+14*86400000).toISOString().slice(0,10)}}
    ],
    OPS_02:[
      {label:'Match staffed hours',explanation:'Run lead ads only while someone can respond.',patch:{scheduleHours:confirmed(state,'responseHours')}},
      {label:'Plan after-hours follow-up',explanation:'Keep schedule and state the response plan.',patch:{audienceNote:'After-hours enquiries receive a response next staffed day.'}}
    ],
    TRACK_01:[
      {label:'Use enquiry goal',explanation:'Set a goal aligned with tracked enquiries.',patch:{goal:'qualified_leads'}},
      {label:'Keep order goal',explanation:'Record verified orders in the merchant outcomes ledger.',patch:{audienceNote:'Merchant will record verified orders manually.'}}
    ],
    COPY_01:[
      {label:'Update copy to offer',explanation:'Remove the mismatched discount claim.',patch:{creatives:c.creatives.map(x=>({...x,description:`${c.offer}. Contact us for details.`}))}},
      {label:'Remove discount from copy',explanation:'Use generic offer wording until confirmed.',patch:{creatives:c.creatives.map(x=>({...x,headline:'Explore our offer',description:'Contact us for current details.'}))}}
    ],
    POL_01:[
      {label:'Use cautious copy',explanation:'Remove the possible unsupported claim.',patch:{creatives:c.creatives.map(x=>({...x,description:'Contact us to learn more about this offer.'}))}},
      {label:'Use offer only',explanation:'Keep only the confirmed offer statement.',patch:{creatives:c.creatives.map(x=>({...x,description:c.offer}))}}
    ],
    CFG_01:[
      {label:'Set a small test cap',explanation:'Use a valid example cap; edit it before approval.',patch:{budgetTotal:1000,budgetDaily:200,
        startDate:new Date(Date.now()+86400000).toISOString().slice(0,10),
        endDate:new Date(Date.now()+7*86400000).toISOString().slice(0,10)}}
    ]
  };
  return (all[ruleId]||[]).map((x,i)=>({id:`${ruleId}_${i}`,ruleId,...x}));
}
