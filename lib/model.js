import { randomUUID, createHash } from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const clone = value => structuredClone(value);
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const field = (value = null, source = 'unknown') => ({ value, source, updatedAt: now() });
export const value = (state, name) => state.profile[name]?.value ?? null;
export const confirmed = (state, name) => state.profile[name]?.source === 'user_confirmed' ? value(state, name) : null;

export const PROFILE_FIELDS = [
  'name','type','offer','objective','campaignRegions','serviceRegions','budgetTotal','budgetDaily',
  'startDate','endDate','availability','responseHours','conversionGoal','sku','price',
  'contributionBeforeDiscount','contributionBasisConfirmed','discount','extraFulfilmentCost',
  'acceptableOrders','minimumOrder','leadSla','orderTracking','website','city','state'
];

export const TOPICS = ['Local shopping','Home renovation','Travel','Food and recipes','Fashion','Business supplies','Technology','Gambling'];
const dateAfter = days => new Date(Date.now()+days*86400000).toISOString().slice(0,10);

export function newState(sessionId = id(), locale = 'en') {
  const profile = Object.fromEntries(PROFILE_FIELDS.map(k => [k, field()]));
  return {
    session: { id: sessionId, locale, mode: 'basic', createdAt: now(), lastSeenAt: now() },
    businessId:id(),
    profile, profileVersion: 0,
    campaign: null, campaignVersion: 0, inspection: null, inspectionHistory: [],
    chat: [], inventory: [], conversionEvents: [], outcomes: [], scenarios: [],
    proposals: [], audit: [], launch: null, media: null, demo: null,
    analytics: [{name:'session_started',at:now(),campaignId:null,version:0,personaScenario:null,language:locale,status:'NEW'}]
  };
}

function seedProfile(data) {
  return Object.fromEntries(Object.entries(data).map(([k,v]) => [k, field(v, 'user_confirmed')]));
}

export const SEEDS = {
  kirana: {
    label: 'Rajesh · Kirana',
    profile: {
      name:'Rajesh Kirana', type:'kirana', city:'Aliganj', state:'Uttar Pradesh',
      offer:'₹100 off on a qualifying ₹999 basket', objective:'store_visits',
      campaignRegions:['Aliganj'], serviceRegions:['Aliganj'], budgetTotal:2000, budgetDaily:500,
      startDate:dateAfter(2), endDate:dateAfter(3), availability:'available',
      responseHours:'09:00-20:00', conversionGoal:'redemptions',
      price:999, contributionBeforeDiscount:120, contributionBasisConfirmed:true,
      discount:100, extraFulfilmentCost:0, orderTracking:'manual_redemption'
    },
    campaign: { targetRegions:['Aliganj'], budgetTotal:2000, budgetDaily:500, discount:100,
      goal:'store_visits', scheduleHours:'09:00-20:00', offerSku:null }
  },
  boutique: {
    label:'Priya · Boutique',
    profile: {
      name:'Priya Boutique', type:'boutique', city:'Jaipur', state:'Rajasthan',
      offer:'New collection enquiries', objective:'qualified_leads',
      campaignRegions:['Jaipur','Ajmer'], serviceRegions:['Jaipur'], budgetTotal:3000, budgetDaily:500,
      startDate:dateAfter(2), endDate:dateAfter(8), availability:'available',
      responseHours:'10:00-18:00', conversionGoal:'qualified_leads', orderTracking:'manual_leads'
    },
    campaign: {targetRegions:['Jaipur','Ajmer'],budgetTotal:3000,budgetDaily:500,
      goal:'qualified_leads',scheduleHours:'08:00-22:00',offerSku:null}
  },
  manufacturer: {
    label:'Gujarat · Manufacturer',
    profile: {
      name:'Gujarat FIBC Works',type:'packaging_supplier',state:'Gujarat',
      offer:'FIBC bags for bulk orders',objective:'qualified_leads',
      campaignRegions:['India'],serviceRegions:['Gujarat'],budgetTotal:10000,budgetDaily:1000,
      startDate:dateAfter(2),endDate:dateAfter(11),availability:'available',
      responseHours:'09:00-18:00',conversionGoal:'qualified_leads',minimumOrder:'10 tonnes',
      orderTracking:'manual_leads'
    },
    campaign: {targetRegions:['India'],budgetTotal:10000,budgetDaily:1000,
      goal:'qualified_leads',scheduleHours:'09:00-18:00',offerSku:null}
  },
  stock: {
    label:'Arjun · Catalog',
    profile: {
      name:'Arjun Catalog',type:'ecommerce',offer:'Featured storage organizer',
      objective:'orders',campaignRegions:['India'],serviceRegions:['India'],
      budgetTotal:5000,budgetDaily:500,startDate:dateAfter(2),endDate:dateAfter(12),
      availability:'unavailable',sku:'ORG-01',conversionGoal:'orders',orderTracking:'clicks_only'
    },
    campaign: {targetRegions:['India'],budgetTotal:5000,budgetDaily:500,
      goal:'orders',scheduleHours:'all_day',offerSku:'ORG-01'},
    inventory:[{sku:'ORG-01',name:'Storage organizer',quantity:0,active:true,lastUpdated:'2026-11-12'}]
  }
};

export function makeDraft(state) {
  const p = state.profile;
  const get = k => p[k]?.value ?? null;
  const offer = get('offer') || 'Your offer';
  const type = get('type') || 'business';
  const goal = get('objective') || 'qualified_leads';
  const copy = `${offer}. Contact ${get('name') || 'us'} to learn more.`;
  return {
    id: state.campaign?.id || id(), businessId:state.businessId, status:'DRAFT', goal,
    targetRegions: clone(get('campaignRegions') || get('serviceRegions') || []),
    excludedRegions:[], budgetTotal:get('budgetTotal'), budgetDaily:get('budgetDaily'),
    startDate:get('startDate'), endDate:get('endDate'), scheduleHours:get('responseHours') || 'all_day',
    offer, offerSku:get('sku'), discount:get('discount'), minimumOrderText:null,
    cta: type === 'kirana' ? 'Visit store' : goal === 'orders' ? 'Shop now' : 'Contact us',
    destination:get('website') || (type === 'kirana' ? 'store_visit' : 'phone_or_message'),
    includedTopics:[], excludedTopics:[], format:'text', audienceNote:'', productPriority:'',
    creatives:[
      {id:id(),headline:offer.slice(0,60),description:copy.slice(0,150),language:'en',approved:false},
      {id:id(),headline:`Discover ${get('name') || 'our business'}`.slice(0,60),description:copy.slice(0,150),language:'en',approved:false}
    ],
    confirmedFields:{targetRegions:confirmed(state,'campaignRegions')!==null||confirmed(state,'serviceRegions')!==null,
      discount:confirmed(state,'discount')!==null,budgetTotal:confirmed(state,'budgetTotal')!==null,
      budgetDaily:confirmed(state,'budgetDaily')!==null},
    source:'Template suggested', updatedAt:now()
  };
}

export function loadSeed(sessionId, key, locale='en') {
  const seed = SEEDS[key];
  if (!seed) throw new Error('Unknown example');
  const state = newState(sessionId, locale);
  Object.assign(state.profile, seedProfile(seed.profile));
  state.profileVersion = 1;
  state.campaign = makeDraft(state);
  Object.assign(state.campaign, clone(seed.campaign));
  state.campaignVersion = 1;
  state.inventory = clone(seed.inventory || []);
  state.demo = key;
  state.audit.push({id:id(),at:now(),actor:'system',type:'demo_profile_loaded',status:'applied',revision:1,
    explanation:`Loaded editable ${seed.label} example`,before:null,after:{seed:key}});
  return state;
}

export function snapshot(state) {
  return {profile:state.profile,campaign:state.campaign,inventory:state.inventory,
    pendingProposals:state.proposals.filter(p=>p.status==='pending'),profileVersion:state.profileVersion,
    campaignVersion:state.campaignVersion};
}
export const snapshotHash = state => hash(snapshot(state));

export function bump(state, actor, type, before, after, explanation='') {
  state.campaignVersion += 1;
  if (state.campaign) {state.campaign.updatedAt=now();state.campaign.status='DRAFT';}
  state.inspection = null;
  state.audit.push({id:id(),at:now(),actor,type,status:'applied',revision:state.campaignVersion,
    explanation,before:clone(before),after:clone(after)});
  state.launch = null;
}
