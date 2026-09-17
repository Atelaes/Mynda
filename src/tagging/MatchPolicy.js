// Automatic acceptance policy. Discovery supplies records and observations;
// this module decides whether that evidence permits a match. No requests,
// caches, library writes or artwork downloads belong here.
const MovieSearch = require('./MovieSearch');
const EpisodeMatch = require('./EpisodeMatch');
const Evidence = require('./TaggingEvidence');
const Decision = require('./TaggingDecision');
const {validImdbID,episodeResponseMatches} = require('./CatalogResponse');
const {scopeFor} = require('./SeriesCollection');

function evaluateMovie(record, candidate, video, options) {
  const evaluation = MovieSearch.evaluateFullResult(record, candidate, video, options);
  if (evaluation.confident && evaluation.matchKind === 'canonical') {
    // Token containment plus a similar year/runtime cannot establish an
    // alternate title. A catalog alias must be evidence, never an inference
    // from the very candidate being evaluated.
    return {...evaluation, confident:false, reasons:[...evaluation.reasons,
      'An expanded movie title needs an independently verified alternate title'],
      policyReason:'unverified-title-expansion'};
  }
  return evaluation;
}

function evaluateEpisode({localTitle, record, titleAssessment, runtimeAssessment, confidentSeries, remoteTitle, video}) {
  if (titleAssessment.state === 'contradiction') return {
    accepted:false, reason:`Episode title mismatch: "${localTitle}" does not agree with OMDb's "${record.Title}".`
  };
  if (!remoteTitle && !confidentSeries) return {
    accepted:false, policyReason:'unconfirmed-series', reason:'OMDb returned a generic episode title for an unconfirmed series. Select the correct series before retrying.'
  };
  if (localTitle && titleAssessment.state === 'inconclusive') return {
    accepted:false, reason:'The current episode title could not be verified against the catalog record',
    policyReason:'unverified-episode-title'
  };
  if (runtimeAssessment && runtimeAssessment.state === 'contradiction') return {
    accepted:false, reason:`Episode runtime mismatch: the video is ${runtimeAssessment.localMinutes.toFixed(1)} minutes, but OMDb reports ${runtimeAssessment.omdbMinutes} minutes.`
  };
  if (runtimeAssessment && video && !video.dvd) {
    const local = runtimeAssessment.localMinutes, remote = runtimeAssessment.omdbMinutes;
    const explicitSplit = /\b(?:part|pt|cd|disc|disk)\s*[. -]?\s*(?:\d+|[ivx]+|one|two)\b/i.test(video.title || '');
    if (local && remote && Math.abs(local-remote)>5 &&
        (local/remote>1.65 || (remote/local>1.65 && !explicitSplit))) return {
      accepted:false, reason:'The file and catalog runtimes suggest different episode coverage; verify split or combined episodes',
      policyReason:'episode-coverage-mismatch'
    };
  }
  return {accepted:true};
}

function evaluateEpisodeOrder({anchors, record, evidence}) {
  if (evidence.localTitle) return {accepted:true, basis:'individual-title'};
  const support = Evidence.copy(anchors);
  const reject = reason => ({accepted:false, reason, policyReason:'unverified-episode-order',support});
  if (anchors.some(anchor => anchor.parent !== evidence.seriesID)) {
    return reject('Named files in this season identify conflicting series');
  }
  if (anchors.some(anchor => anchor.localSeason !== anchor.catalogSeason || anchor.localEpisode !== anchor.catalogEpisode)) {
    return reject('Named files in this season use different catalog numbering; this numbered-only file needs verification');
  }
  if (anchors.some(anchor => anchor.id === record.imdbID && anchor.localEpisode !== String(evidence.requested.episode))) {
    return reject('This catalog episode is independently identified at a different local position');
  }
  const structure=evidence.parentEvidence && evidence.parentEvidence.support && evidence.parentEvidence.support.structure;
  const scope=scopeFor(evidence.original);
  const local=structure && structure.profile && scope && (structure.profile.numberingScopes || []).find(item=>
    item.directoryKey===scope.directoryKey && item.season===Number(evidence.requested.season));
  const parent=structure && (structure.candidates || []).find(item=>item.seriesID===evidence.seriesID);
  const season=parent && parent.seasons.find(item=>item.season===Number(evidence.requested.season));
  if (local && season && season.count && local.positions.length===season.count &&
      local.positions.every((ep,i)=>ep===i) && !anchors.some(anchor=>Number(anchor.localEpisode)>0)) {
    return {...reject('This release numbers a complete season from zero while the catalog starts at one; verify episode alignment'),
      numberingEvidence:{local:local.positions,catalog:season.positions,basis:'different-numbering-origin'}};
  }
  const verified = new Set(anchors.map(anchor => anchor.id)).size >= 2 &&
    new Set(anchors.map(anchor => anchor.localEpisode)).size >= 2;
  // Lack of named witnesses is not contrary evidence. Explicit numbering is
  // usable once discovery establishes the parent; the contradictions above
  // still prevent silently applying a demonstrated different episode order.
  return {accepted:true, basis:verified ? 'consistent-named-siblings' :
    evidence.parentEvidence && evidence.parentEvidence.confident ? 'confident-series-numbering' : 'catalog-position', verified,support};
}

// The only final acceptance function. Discovery can preview these same pure
// assessments to rank candidates, but applying tags always evaluates here.
function decide(proposal, context = {}, options = {}) {
  const {video,record,evidence:detail} = proposal;
  const evidence = Evidence.forMatch(video,record,detail,{...context,recordSelectionSource:options.recordSelectionSource});
  const reject = (message,code='identity-mismatch') => Decision.decision('unmatched',
    {code,message},evidence,{failure:detail.kind === 'movie' ? 'No results' : 'Episode mismatch'});
  if (!record || record.Response !== 'True' || !validImdbID(record.imdbID) ||
      typeof record.Title !== 'string' || !record.Title.trim() || !['movie','series','episode'].includes(record.Type)) {
    return Decision.decision('service-error',
      {code:'malformed-catalog-record',message:'The catalog did not supply a valid identity'},evidence,{failure:'Error'});
  }
  if (detail.kind === 'explicit-id') {
    if (record.imdbID !== String(detail.requestedID || '').trim()) return reject('The catalog returned a different IMDb identity than requested');
  } else if (detail.kind === 'movie') {
    const assessment = evaluateMovie(record,detail.candidate,video,detail.validationOptions || {});
    evidence.movieAssessment = assessment;
    if (!assessment.confident) return reject(assessment.reasons.join('; '),assessment.policyReason || 'unverified-movie');
  } else if (detail.kind === 'episode') {
    if (!detail.matched || !episodeResponseMatches(record,detail.seriesID,
        String(detail.matched.season),String(detail.matched.episode))) return reject('The episode record does not match the resolved parent and position');
    const localTitle = EpisodeMatch.usefulEpisodeTitle(video.title,video.series,{dvd:Boolean(video.dvd)});
    const titleAssessment = EpisodeMatch.assessEpisodeTitle(localTitle,record.Title,video.series);
    const runtimeAssessment = EpisodeMatch.assessEpisodeRuntime(video,record);
    Object.assign(evidence,{localTitle,titleAssessment,runtimeAssessment,
      titleComparison:EpisodeMatch.episodeTitleComparison(localTitle,record.Title,video.series)});
    const assessment = evaluateEpisode({video,record,localTitle,titleAssessment,runtimeAssessment,
      confidentSeries:Boolean(detail.parentEvidence && detail.parentEvidence.confident),
      remoteTitle:EpisodeMatch.usefulEpisodeTitle(record.Title)});
    if (!assessment.accepted) return reject(assessment.reason,assessment.policyReason || 'episode-mismatch');
    const order = options.recordSelectionSource === 'user' ?
      {accepted:true,basis:'user-confirmed-record',support:[]} :
      evaluateEpisodeOrder({anchors:options.anchors || [],record,evidence});
    evidence.orderAssessment = order;
    if (!order.accepted) return reject(order.reason,order.policyReason);
  } else return reject('The candidate has no recognized source of identity evidence');
  return Decision.decision('matched',{code:'identity-accepted',message:'The identity passed the acceptance policy'},evidence);
}

module.exports = {evaluateMovie,evaluateEpisode,evaluateEpisodeOrder,decide};
