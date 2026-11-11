import { id, now, clone } from './model.js';

export const demoProvider = {
  name:'BoloAds simulated provider',
  validateDraft(campaign) {
    const errors=[];
    if(!campaign) errors.push('Campaign is missing.');
    else {
      if(!campaign.goal) errors.push('Goal is missing.');
      if(!Array.isArray(campaign.targetRegions)||!campaign.targetRegions.length) errors.push('Target region is missing.');
      if(!(campaign.budgetTotal>0)) errors.push('Total cap is missing.');
      if(!campaign.startDate||!campaign.endDate) errors.push('Schedule is missing.');
    }
    return {valid:errors.length===0,errors};
  },
  previewPayload(campaign) {
    if(!campaign)return null;
    return {provider:this.name,simulationOnly:true,validation:this.validateDraft(campaign),
      payload:{objective:campaign.goal,geography:{include:campaign.targetRegions,exclude:campaign.excludedRegions},
        budget:{currency:'INR',totalCap:campaign.budgetTotal,dailyCap:campaign.budgetDaily},
        schedule:{start:campaign.startDate,end:campaign.endDate,hours:campaign.scheduleHours},
        creative:campaign.creatives.map(x=>({headline:x.headline,description:x.description,language:x.language,merchantApproved:x.approved})),
        context:{include:campaign.includedTopics,exclude:campaign.excludedTopics}},
      unsupportedMappings:['Live publisher inventory','Platform-specific policy approval','Real audience reach','Actual billing']};
  },
  simulatePublish(campaign) {
    const validation=this.validateDraft(campaign);
    if(!validation.valid) throw new Error(validation.errors.join(' '));
    return {id:`DEMO-${campaign.id.slice(0,8).toUpperCase()}`,at:now(),status:'APPROVED_SIMULATED',
      notice:'This is a simulated campaign launch. No ad was published or charged.',snapshot:clone(campaign),provider:this.name};
  },
  getStatus(launch) {return launch?.status||'NOT_LAUNCHED';}
};
