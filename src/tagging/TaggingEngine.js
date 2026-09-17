// Application-independent coordinator. Resolvers propose; policy decides;
// the applier is called only here, after the final decision is matched.
const Decision = require('./TaggingDecision');
const Evidence = require('./TaggingEvidence');
const Policy = require('./MatchPolicy');
const SeriesSearch = require('./SeriesSearch');
const {createRequestBudget} = require('./RequestBudget');
const {requestFailure} = require('./CatalogResponse');
const {createMovieResolver} = require('./MovieResolver');
const {createSeriesResolver} = require('./SeriesResolver');
const {createEpisodeResolver} = require('./EpisodeResolver');
const {createSeriesStructureResolver} = require('./SeriesStructureResolver');
const {profileFor} = require('./SeriesStructure');
const cloneDeep = require('lodash/cloneDeep');

function createTaggingEngine({client,applier,log,withEpisodeDuration}) {
  let nextSearchNumber = 0;
  function createContext(options = {}) {
    const seriesSession = options.seriesSearchSession || SeriesSearch.createSession();
    return {searchID:`${process.pid}-${++nextSearchNumber}`,seriesSession,
      requestSession:seriesSession.catalog,requestTrace:[],
      requestBudget:options.requestBudget || createRequestBudget(options.requestBudgetLimit),
      seriesSelectionSource:options.seriesSelectionSource || 'user',
      selectedSeriesID:options.seriesImdbID,deferSeriesEvidence:Boolean(options.deferSeriesEvidence),
      parentEvidence:options.parentEvidence};
  }
  const movies = createMovieResolver({...client,log});
  const series = createSeriesResolver({...client,log,
    searchShowEpisode:(...args) => episodes.resolve(...args)});
  const episodes = createEpisodeResolver({...client,log,resolveSeries:series.resolve,withEpisodeDuration});
  const structure = createSeriesStructureResolver({...client,log});

  async function resolveSeriesStructure(profile,choices,options = {}) {
    const context=createContext(options);
    context.canContinue=options.canContinue;
    let result;
    try { result=await structure(profile,choices,context); }
    catch(error) { result={failure:{failure:'Error',data:error}}; }
    return result.failure ? Decision.fromDiscovery(result.failure,{},context) : result;
  }

  function logDecision(video,result,context) {
    const level = result.status === 'matched' ? 'info' : result.status === 'service-error' ? 'error' : 'warn';
    log[level]('Tagging decision',{searchID:context.searchID,videoID:video.id,filename:video.filename,
      status:result.status,reason:result.reason,evidence:result.evidence});
  }

  async function discover(video,context,options) {
    if (video && video.kind === 'show' && (options.seriesImdbID || !Decision.hasImdbID(video))) {
      return episodes.resolve(video,context,options.seriesImdbID,options.seasonOffsetHints);
    }
    if (!Decision.hasImdbID(video)) return movies.resolve(video,context);
    const response = await client.pollOMDB(client.createURLParts({id:video.imdbID}),{...context,stage:'exact IMDb lookup'});
    const failure = requestFailure(response);
    if (failure) return failure;
    if (video.kind === 'show' && response.data.Type === 'series' && response.data.imdbID === video.imdbID.trim()) {
      const source = Evidence.identity(video,'imdbID',options.imdbIDSource);
      return episodes.resolve(video,{...context,seriesSelectionSource:source.origin === 'user' ? 'user' : 'stored',
        parentEvidence:source},response.data.imdbID);
    }
    return Decision.candidate(video,response.data,{kind:'explicit-id',requestedID:video.imdbID,
      source:Evidence.identity(video,'imdbID',options.imdbIDSource).origin});
  }

  async function resolve(video,options = {}) {
    video = cloneDeep(video);
    const context = createContext(options || {});
    context.originalInput = Evidence.snapshot(video);
    let raw;
    try { raw = await discover(video,context,options || {}); }
    catch(error) { raw = {success:false,failure:'Error',data:error}; }
    const result = Decision.fromDiscovery(raw,video,context);
    if (result.status !== 'candidate') logDecision(video,result,context);
    return result;
  }

  async function applyMatch(proposal,options = {}) {
    if (!proposal || proposal.status !== 'candidate') return proposal;
    const {candidate,context} = proposal;
    let result;
    try {
      result = Policy.decide(candidate,context,options);
      if (result.status === 'matched') {
        const applied = await applier.apply(candidate.video,candidate.record,context);
        if (candidate.evidence.kind === 'episode') applied.data.seriesImdbID = candidate.evidence.seriesID;
        // Include requests made for optional artwork, without replacing the
        // original observations or the identity's prior authorship on refresh.
        result.evidence.requests = Evidence.copy(context.requestTrace);
        result.evidence.requestBudget = Evidence.copy(context.requestBudget);
        applied.data.taggingEvidence = Evidence.copy(result.evidence);
        result.video = applied.data;
      }
    } catch(error) {
      result = Decision.fromDiscovery({failure:'Error',data:error,evidence:candidate.evidence},candidate.video,context);
    }
    logDecision(candidate.video,result,context);
    return result;
  }

  async function tag(video,options) { return applyMatch(await resolve(video,options)); }

  async function preflight(videos,options = {}) {
    const context = createContext(options);
    let raw;
    try { raw = await series.resolveForBatch(videos,options,context); }
    catch(error) { raw = {failure:'Error',data:error}; }
    if (raw.success) return {status:'parent-resolved',seriesID:raw.data,evidence:raw.evidence};
    // Named representatives get the first opportunity. Structural evidence is
    // used only if they leave multiple same-name parents unresolved.
    const profile=raw.choiceType === 'series' && raw.choices && profileFor(videos);
    if (profile) {
      let structural;
      try { structural=await structure({...profile,choiceConstraints:raw.seriesChoiceConstraints || []},raw.choices,context); }
      catch(error) { structural={failure:{failure:'Error',data:error}}; }
      if (structural.status === 'parent-resolved') return structural;
      if (structural.failure) raw=structural.failure;
      else if (structural.evidence) raw={...raw,evidence:{...raw.evidence,structure:structural.evidence.structure}};
    }
    const result = Decision.fromDiscovery(raw,videos[0] || {},context);
    logDecision(videos[0] || {},result,context);
    return result;
  }

  return {resolve,applyMatch,tag,preflight,resolveSeriesStructure,
    createSeriesSearchSession:SeriesSearch.createSession,seriesSearchSummary:SeriesSearch.sessionSummary};
}

module.exports = {createTaggingEngine};
