// One bounded recovery plan, after independent first-pass observations.
// The runner owns saving; this module never applies a candidate or changes tags.
const Evidence = require('./TaggingEvidence');

async function planRecovery({pending,ledger,catalog,session,budgets,canContinue}) {
  const retries=pending.map(item=>({...item,parent:ledger.parentFor(item.video,item.result)}));
  let structureChecks=0;
  if (typeof catalog.resolveSeriesStructure !== 'function') return {retries,structureChecks};
  for (const group of ledger.structureGroups(retries)) {
    if (!await canContinue()) break;
    const ordered=group.pending.slice().sort((a,b)=>String(a.video.filename).localeCompare(String(b.video.filename)) || String(a.video.id).localeCompare(String(b.video.id)));
    // Keep every discovered alternative in view. Counts cannot override a
    // narrower choice list supported by any episode's title evidence.
    const choices=[...new Map(ordered.flatMap(item=>item.result.choices).map(choice=>[choice.imdbID,choice])).values()];
    const profile={...group.profile,choiceConstraints:ordered.filter(item=>item.result.choices.length < choices.length)
      .map(item=>({videoID:item.video.id,title:item.video.title,candidates:item.result.choices.map(choice=>choice.imdbID)}))};
    const result=await catalog.resolveSeriesStructure(profile,choices,{
      seriesSearchSession:session,requestBudget:budgets[ordered[0].index],canContinue});
    if (result.status==='canceled') break;
    structureChecks++;
    for (const item of ordered) {
      if (result.status==='parent-resolved') {
        if (item.result.choices.some(choice=>choice.imdbID===result.seriesID)) item.parent={
          seriesID:result.seriesID,source:'structure',evidence:result.evidence};
      } else if (result.status==='service-error') {
        item.resolutionError={...result,evidence:{...result.evidence,
          original:Evidence.snapshot(item.video),input:Evidence.snapshot(item.video)}};
      } else if (result.evidence) {
        item.structureEvidence=result.evidence;
      }
    }
  }
  return {retries,structureChecks};
}
module.exports = {planRecovery};
