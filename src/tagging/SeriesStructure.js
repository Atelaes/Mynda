// Pure, serializable series-structure evidence. Local maxima are lower bounds.
// Two distinct season totals may favor a shorter candidate; one observed
// position beyond an alternative's reported bounds can exclude that alternative.
const {normalizeEpisodeNumber,validImdbID} = require('./CatalogResponse');
const {scopeFor} = require('./SeriesCollection');
const {BONUS_TITLE_PATTERNS} = require('./CatalogAliases');
const Identity = require('./SeriesIdentity');
const Search = require('./SeriesSearch');

const number = value => {
  const normalized = normalizeEpisodeNumber(value), n = Number(normalized);
  return normalized !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
};
function regularPosition(video) {
  const inferredSeason=Identity.canInferSingleSeason(video);
  const season = inferredSeason ? 1 : number(video && video.season);
  const normalized=normalizeEpisodeNumber(video && video.episode), episode=Number(normalized);
  if (!scopeFor(video) || season === null || normalized === null || !Number.isSafeInteger(episode) || episode < 0 ||
      BONUS_TITLE_PATTERNS.some(pattern => pattern.test(String(video.title || '')))) return null;
  return {season,episode,...(inferredSeason ? {inferredSeason:true} : {})};
}
function profileFor(videos) {
  const members = videos.map(video => ({video,scope:scopeFor(video)})).filter(item=>item.scope);
  if (!members.length || new Set(members.map(item=>item.scope.key)).size !== 1) return null;
  const years = [...new Set(members.flatMap(item=>item.scope.years))].sort();
  const parents = [...new Set(members.filter(({video})=>validImdbID(video.seriesImdbID)).map(({video})=>video.seriesImdbID.trim()))].sort();
  if (years.length > 1 || parents.length > 1) return null;
  const seasons = new Map(), numberingScopes=new Map();
  let inferredSeason=false;
  for (const {video,scope} of members) {
    const position = regularPosition(video);
    if (!position) continue;
    inferredSeason ||= Boolean(position.inferredSeason);
    const orderKey=JSON.stringify([scope.directoryKey,position.season]);
    if (!numberingScopes.has(orderKey)) numberingScopes.set(orderKey,{
      directoryKey:scope.directoryKey,season:position.season,positions:new Set()});
    numberingScopes.get(orderKey).positions.add(position.episode);
    // Episode zero is order evidence, not an ordinary positive season total.
    if (position.episode === 0) continue;
    if (!seasons.has(position.season)) seasons.set(position.season,new Set());
    seasons.get(position.season).add(position.episode);
  }
  if (!seasons.size) return null;
  return {collection:members[0].scope.root,key:members[0].scope.key,series:members[0].scope.series,
    year:years[0] || null,parents,inferredSeason,
    numberingScopes:[...numberingScopes.values()].map(item=>({...item,positions:[...item.positions].sort((a,b)=>a-b)}))
      .sort((a,b)=>a.directoryKey.localeCompare(b.directoryKey) || a.season-b.season),
    seasons:[...seasons].sort(([a],[b])=>a-b).map(([season,episodes])=>{
      const positions=[...episodes].sort((a,b)=>a-b);
      return {season,positions,maxEpisode:positions[positions.length-1]};
    })};
}

function eligibleChoice(profile,choice) {
  if (!choice || choice.Type !== 'series' || !validImdbID(choice.imdbID)) return false;
  const parts={title:profile.series,year:profile.year};
  if (!Identity.seriesYearMatches(profile.year,choice.Year) || Search.regionRejection(parts,choice)) return false;
  const matching=Identity.matchingSeriesResults(profile.series,profile.year,[choice]);
  return (matching.candidates.length > 0 && matching.matchStrength !== 'fuzzy') ||
    Search.buildQueries(parts).some(query=>!Search.candidateRejection(query,choice));
}

function seasonEvidence(data,season,seriesID) {
  const unknown = reason => ({season,status:'unknown',reason,invalid:Boolean(data),positions:[],count:null,maxEpisode:null});
  if (!data || data.Response !== 'True' || number(data.Season) !== season || !Array.isArray(data.Episodes) ||
      (data.imdbID && data.imdbID !== seriesID) || (data.seriesID && data.seriesID !== seriesID)) return unknown('missing or mismatched season list');
  const entries = new Map(), ids = new Map();
  let malformed=false;
  for (const row of data.Episodes) {
    const ep=number(row && row.Episode), id=row && row.imdbID;
    if (!ep || !validImdbID(id) || (row.Type && row.Type !== 'episode')) {malformed=true;continue;}
    if ((entries.has(ep) && entries.get(ep)!==id) || (ids.has(id) && ids.get(id)!==ep)) malformed=true;
    entries.set(ep,id);ids.set(id,ep);
  }
  const positions=[...entries.keys()].sort((a,b)=>a-b);
  const contiguous=positions.length > 0 && positions.every((ep,index)=>ep===index+1);
  // Sparse/invalid lists never imply that a season ends at their last row.
  // A contiguous list is a reported total, not certainty about provider coverage.
  return {season,status:malformed?'unknown':'listed',invalid:malformed,positions:malformed?[]:positions,
    count:!malformed && contiguous?positions.length:null,
    maxEpisode:!malformed && positions.length?positions[positions.length-1]:null,
    reason:malformed?'conflicting or invalid season rows':!contiguous?'incomplete season list':'contiguous season list'};
}

function assess(profile,observations) {
  const candidates=observations.map(observation=>{
    const contradictions=[],supported=[],exactCounts=[];
    for (const local of profile.seasons) {
      const catalog=observation.seasons.find(item=>item.season===local.season);
      if (observation.totalSeasons && local.season > observation.totalSeasons) {
        contradictions.push({season:local.season,reason:'season exceeds reported series total',limit:observation.totalSeasons});
      } else if (catalog && catalog.count !== null && local.maxEpisode > catalog.count) {
        contradictions.push({season:local.season,reason:'episode exceeds reported season total',observed:local.maxEpisode,limit:catalog.count});
      } else if (catalog && catalog.positions.includes(local.maxEpisode)) {
        supported.push(local.season);
        if (catalog.count === local.maxEpisode) exactCounts.push(local.season);
      }
    }
    if (profile.parents.length && !profile.parents.includes(observation.seriesID)) contradictions.push({reason:'different declared parent'});
    const titleConflicts=(profile.choiceConstraints || []).filter(constraint=>
      !constraint.candidates.includes(observation.seriesID));
    return {...observation,contradictions,supported,exactCounts,titleConflicts};
  });
  const proposed=[];
  for (const candidate of candidates) {
    if (candidate.contradictions.length || candidate.titleConflicts.length ||
        candidate.supported.length !== profile.seasons.length ||
        (profile.inferredSeason && candidate.totalSeasons !== 1)) continue;
    const comparisons=[];
    for (const other of candidates.filter(item=>item.seriesID!==candidate.seriesID)) {
      if (other.contradictions.length) {
        comparisons.push({alternative:other.seriesID,basis:'exceeds-alternative',contradictions:other.contradictions});
        continue;
      }
      const distinguishing=candidate.exactCounts.filter(season=>{
        const alternate=other.seasons.find(item=>item.season===season);
        const local=profile.seasons.find(item=>item.season===season);
        return alternate && alternate.maxEpisode > local.maxEpisode;
      });
      if (distinguishing.length >= 2) {
        comparisons.push({alternative:other.seriesID,basis:'two-season-counts',seasons:distinguishing});
        continue;
      }
      // Positive identity evidence need not disprove an incomplete alternative.
      // Require a fully represented, deduplicated 1..N season with an exact
      // catalog total. Known longer alternatives retain the two-season rule.
      const positive=candidate.exactCounts.filter(season=>{
        const local=profile.seasons.find(item=>item.season===season);
        const alternate=other.seasons.find(item=>item.season===season);
        return local.positions.length===local.maxEpisode && local.positions.every((ep,i)=>ep===i+1) &&
          other.metadataStatus!=='invalid' && other.seasons.every(item=>!item.invalid) &&
          // A known multi-season alternative has an unknown LOCAL season here,
          // not a catalog coverage gap. Do not manufacture missing-count evidence.
          !(profile.inferredSeason && other.totalSeasons>1) &&
          (!alternate || alternate.count===null);
      });
      if (!distinguishing.length && positive.length) comparisons.push({alternative:other.seriesID,
        basis:'positive-season-count',seasons:positive,alternativeIncomplete:true});
    }
    if (candidates.length > 1 && comparisons.length === candidates.length-1) proposed.push({seriesID:candidate.seriesID,comparisons});
  }
  const choice=proposed.length === 1 ? proposed[0] : null;
  return {selectedID:choice && choice.seriesID,basis:choice?'season-structure':'ambiguous-season-structure',
    profile,candidates,comparisons:choice?choice.comparisons:[]};
}
module.exports = {number,regularPosition,profileFor,eligibleChoice,seasonEvidence,assess};
