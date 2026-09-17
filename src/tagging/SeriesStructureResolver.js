// Catalog observations for the pure structural comparison. Uses the existing
// client/session/budget; it never applies tags or treats a missing row as a zero.
const Structure = require('./SeriesStructure');
const Identity = require('./SeriesIdentity');
const Evidence = require('./TaggingEvidence');
const {requestFailure,episodeResponseMatches} = require('./CatalogResponse');
const Limits = require('./TaggingLimits');

function createSeriesStructureResolver({pollOMDB,createURLParts,log}) {
  return async function resolve(profile,choices,context) {
    const eligible=[...new Map(choices.filter(choice=>Structure.eligibleChoice(profile,choice))
      .map(choice=>[choice.imdbID,choice])).values()].sort((a,b)=>a.imdbID.localeCompare(b.imdbID));
    // Never narrow an unreviewed/fuzzy candidate list by silently dropping a
    // competing identity. Discovery must establish the full-title candidates.
    if (eligible.length < 2 || eligible.length !== new Set(choices.map(choice=>choice.imdbID)).size ||
        eligible.length > Limits.series.structureCandidates) {
      const assessment={selectedID:null,basis:eligible.length > Limits.series.structureCandidates ?
        'structure-candidate-limit':'ineligible-structure-candidates',profile,
        candidateCount:choices.length,candidateLimit:Limits.series.structureCandidates};
      const evidence=Evidence.envelope({}, {kind:'series-structure',structure:assessment},context);
      log.info('Series structure assessment',{searchID:context.searchID,collection:profile.collection,
        series:profile.series,selectedID:null,evidence});
      return {status:'unresolved',evidence};
    }
    const observations=[];
    for (const choice of eligible) {
      if (context.canContinue && !await context.canContinue()) return {status:'canceled'};
      const response=await pollOMDB(createURLParts({id:choice.imdbID}),{...context,stage:'series structure metadata'});
      const failure=requestFailure(response);
      if (failure && failure.failure !== 'No results') return {failure};
      const metadata=response && response.data;
      const valid=!failure && metadata.Type==='series' && metadata.imdbID===choice.imdbID &&
        Identity.comparableSeriesTitle(metadata.Title)===Identity.comparableSeriesTitle(choice.Title) &&
        Identity.seriesYearMatches(String(choice.Year || '').match(/^(?:19|20)\d{2}/)?.[0],metadata.Year);
      const observation={seriesID:choice.imdbID,title:choice.Title,year:choice.Year,
        totalSeasons:valid?Structure.number(metadata.totalSeasons):null,seasons:[],
        metadataStatus:valid?'verified':failure?'missing':'invalid'};
      observations.push(observation);
      if (!valid) {observation.reason='parent metadata unavailable or inconsistent';continue;}
      // A blank local season is only a proposal for Season 1. Confirm it for
      // each parent before using its episode bounds; otherwise retain unknown
      // evidence rather than eliminating a multi-season show at the wrong season.
      if (profile.inferredSeason && observation.totalSeasons !== 1) {
        observation.reason='missing season not confirmed by single-season metadata';
        continue;
      }
      for (const local of profile.seasons) {
        if (context.canContinue && !await context.canContinue()) return {status:'canceled'};
        if (observation.totalSeasons && local.season > observation.totalSeasons) continue;
        const listed=await pollOMDB(createURLParts({id:choice.imdbID,season:local.season}),
          {...context,stage:'series structure season list'});
        const listFailure=requestFailure(listed);
        if (listFailure && listFailure.failure!=='No results') return {failure:listFailure};
        const season=Structure.seasonEvidence(listFailure?null:listed.data,local.season,choice.imdbID);
        // A season list can omit its tail. Check the actual observed position
        // before excluding a candidate on that list's apparent upper bound.
        if (season.count !== null && local.maxEpisode > season.count) {
          const boundary=await pollOMDB(createURLParts({id:choice.imdbID,season:local.season,episode:local.maxEpisode}),
            {...context,stage:'series structure boundary episode'});
          const boundaryFailure=requestFailure(boundary);
          if (boundaryFailure && boundaryFailure.failure!=='No results') return {failure:boundaryFailure};
          if (!boundaryFailure) {
            season.count=null;
            season.reason='season list contradicted by an episode response';
            if (episodeResponseMatches(boundary.data,choice.imdbID,String(local.season),String(local.maxEpisode)) &&
                boundary.data.seriesID===choice.imdbID) {
              season.positions=[...new Set([...season.positions,local.maxEpisode])].sort((a,b)=>a-b);
              season.maxEpisode=Math.max(season.maxEpisode,local.maxEpisode);
            } else {season.invalid=true;season.reason='inconsistent boundary episode response';}
          }
        }
        observation.seasons.push(season);
      }
    }
    const assessment=Structure.assess(profile,observations);
    const evidence=Evidence.envelope({}, {kind:'series-structure',structure:assessment},context);
    log.info('Series structure assessment',{searchID:context.searchID,collection:profile.collection,
      series:profile.series,selectedID:assessment.selectedID,evidence});
    return assessment.selectedID ? {status:'parent-resolved',seriesID:assessment.selectedID,evidence} : {status:'unresolved',evidence};
  };
}
module.exports = {createSeriesStructureResolver};
