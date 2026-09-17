// Presentation of saved observations only. This module must not run discovery,
// reinterpret acceptance thresholds, make requests, or change video metadata.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const present = value => text(value) !== '';
const id = value => /^tt\d+$/.test(text(value)) ? text(value) : '';
const minutes = value => present(value) && Number.isFinite(Number(value)) && Number(value) > 0 ?
  `${Number(Number(value).toFixed(1))} min` : '';
const position = value => {
  const p = object(value);
  return [present(p.season) ? `Season ${text(p.season)}` : '',
    present(p.episode) ? `episode ${text(p.episode)}` : ''].filter(Boolean).join(', ');
};
const recordLabel = value => {
  const r = object(value);
  return [text(r.Title || r.title || r.catalogTitle), text(r.Year || r.year), id(r.imdbID || r.seriesID)]
    .filter(Boolean).join(' · ');
};

// Unknown/older reason messages can contain transport diagnostics. Never put
// raw URLs, credentials or a multi-line error stack in the editor.
function message(value) {
  return text(value).split(/\r?\n/)[0].replace(/https?:\/\/\S+/gi, '[service address]')
    .replace(/\b(api[-_]?key|token|authorization|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 600);
}

const REASONS = {
  'no-results': ['The searches and lookups performed did not find a safe match. This does not establish that the record is absent from OMDb.',
    'Check the title, year and episode numbers, or select a verified record in Search.'],
  'not-enough-data': ['The available identification was not usable for automatic tagging.',
    'Check the video kind and identifying fields. Extras or disc images may need manual tags.'],
  'ambiguous-series': ['More than one series remained possible. The saved evidence did not establish which one this video belongs to.',
    'Select the correct series in Search, or add a verified series year before retrying.'],
  'ambiguous-results': ['Search returned possible records, but none could be accepted automatically. A suggested result is not necessarily a safe match.',
    'Review the candidates in Search and select the correct record.'],
  'unconfirmed-series': ['The series was not sufficiently established, and the returned episode title could not confirm it.',
    'Select the correct series in Search before retrying.'],
  'episode-mismatch': ['The proposed episode failed an identity check.',
    'Check the episode title, numbering and whether the file is an extra or a different version.'],
  'episode-coverage-mismatch': ['The file and catalog runtimes suggest they cover different amounts of the episode. A combined or split episode is one possible explanation.',
    'Check whether this file contains a whole episode, part of one, or multiple episodes before choosing a record.'],
  'unverified-episode-title': ['The local episode title did not provide enough agreement with the proposed catalog title to accept the match.',
    'Check the episode title and numbering, then select a verified episode if the catalog uses a different title.'],
  'unverified-episode-order': ['The proposed episode numbering could not be verified from the saved evidence.',
    'Verify the episode order for this release before changing numbers or choosing a record.'],
  'unverified-title-expansion': ['The proposed movie has an expanded title that was not independently verified as an alternate name.',
    'Verify the full movie title and year, then select the correct record in Search.'],
  'unverified-movie': ['The proposed movie did not pass the saved identity checks.',
    'Verify the title, year and runtime before selecting a record in Search.'],
  'identity-mismatch': ['The proposed record did not agree with the requested identity.',
    'Check the selected IMDb record and identifying fields before retrying.']
};

function failureExplanation(status, reason) {
  const code = text(reason.code);
  if (status === 'service-error') {
    if (code === 'request-budget-exhausted') return ['The attempt reached its lookup limit before it could finish establishing a match.',
      'Add a more specific title, year or series selection before retrying. This video remains eligible for retry.'];
    if (code === 'malformed-catalog-record') return ['OMDb returned an incomplete or invalid record, so the attempt could not finish.',
      'Try again later. This video remains eligible for retry.'];
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(code + ' ' + text(reason.message))) return ['A catalog request timed out before the attempt could finish.',
      'Try again later. This video remains eligible for retry.'];
    return ['A catalog service or connection error prevented the attempt from finishing.',
      'Check the connection and OMDb settings, then retry. This video remains eligible for retry.'];
  }
  return REASONS[code] || [message(reason.message) || 'This attempt ended without an accepted match. No more specific explanation was saved.',
    'Review the identifying fields and use Search to verify a record.'];
}

function numbers(values) {
  const sorted = [...new Set(array(values).filter(present).map(Number).filter(Number.isFinite))].sort((a,b) => a-b);
  const runs = [];
  for (let i=0; i<sorted.length; i++) {
    const start = sorted[i];
    while (i+1<sorted.length && sorted[i+1] === sorted[i]+1) i++;
    runs.push(start === sorted[i] ? String(start) : `${start}–${sorted[i]}`);
  }
  return runs.slice(0,8).join(', ') + (runs.length>8 ? ', …' : '');
}

const PARENTS = {
  'series-title-and-year':'Series title and year agreed with the catalog.',
  'unique-series-title':'One series passed the title search; episode evidence was still checked separately.',
  'verified-episode-title':'An episode title identified this series.',
  'siblings-series-selection':'Matching episode titles in the same series collection established this parent.',
  'structure-series-selection':'Season and episode numbering supplied the series evidence.',
  'batch-series-selection':'The series was selected during the shared series lookup.',
  'user-series-selection':'You selected this series.',
  'stored-series-id':'The saved series IMDb ID was reused.',
  'stored-parent-id':'The saved series IMDb ID was reused.'
};

function parentDescription(parent) {
  const p = object(parent);
  const base = PARENTS[p.basis] || 'A series candidate was recorded during lookup.';
  const origin = p.origin === 'user' ? 'The series ID came from a user selection.' :
    p.origin === 'legacy' ? 'The original source of this saved ID is unknown.' :
    p.origin === 'automatic' ? 'The series ID came from automatic identification.' : '';
  return [base, origin, p.reuse === 'stored' ? 'That evidence was reused from the saved tags.' : ''].filter(Boolean).join(' ');
}

function candidateDescription(candidate) {
  const c = object(candidate), details = [];
  for (const s of array(c.seasons).slice(0,12)) {
    const season = object(s);
    details.push(`Season ${text(season.season)}: ${season.count != null ? `${text(season.count)} reported episodes` : 'episode total unknown'}` +
      (array(c.exactCounts).includes(season.season) ? '; matches the highest local episode number' : ''));
  }
  if (c.totalSeasons != null) details.push(`${text(c.totalSeasons)} reported season${Number(c.totalSeasons) === 1 ? '' : 's'}`);
  for (const conflict of array(c.contradictions).slice(0,3)) {
    const item = object(conflict);
    details.push(item.reason === 'episode exceeds reported season total' ?
      `Local season ${text(item.season)} reaches episode ${text(item.observed)}, beyond the reported total of ${text(item.limit)}` :
      item.reason === 'season exceeds reported series total' ?
        `Local season ${text(item.season)} exceeds the reported ${text(item.limit)} seasons` : message(item.reason));
  }
  if (array(c.titleConflicts).length) details.push('Conflicts with saved episode-title evidence');
  return details.filter(Boolean).join('. ');
}

function correctionDetails(e) {
  const saved=array(e.correctionChecks);
  const checks=saved.length ? saved : array(e.requests).filter(r=>r &&
    ['nearby episode title probe','adjacent season title probe'].includes(r.stage)).map(r=>({
      kind:r.stage.startsWith('nearby') ? 'nearby-episode' : 'adjacent-season',
      seriesID:object(r.parameters).i,probed:{season:object(r.parameters).Season,episode:object(r.parameters).Episode},
      outcome:r.outcome === 'not-found' ? 'not-found' : 'legacy-response'}));
  const names={'nearby-episode':'Nearby episode','adjacent-season':'Adjacent season','sibling-numbering':'Sibling-supported numbering'};
  const outcomes={
    'not-found':'No episode record was found.',
    'title-mismatch':'A record was returned, but its title did not pass the exact comparison. No correction was selected from this probe.',
    'title-matched':'The title matched exactly; this alone does not mean tags were applied.',
    'selected':'Exact title match; selected for the remaining episode checks.',
    'ambiguous-title':'More than one probed position matched the title, so this correction was not selected.',
    'invalid-record':'The returned record did not identify the requested series and episode.',
    'service-error':'A service error prevented this check from completing.',
    'proposed':'The sibling-supported position was sent through the normal title and runtime checks.',
    'legacy-response':'This lookup was tried, but its detailed title comparison was not saved in this older report.'
  };
  return {items:checks.slice(-40).map(value=>{
    const c=object(value);
    return {label:[names[c.kind] || 'Episode check',position(c.probed),id(c.seriesID)].filter(Boolean).join(' · '),
      record:recordLabel(c),detail:[outcomes[c.outcome] || 'This correction was checked.',
        c.via === 'season-list' ? 'The season-list/IMDb-ID fallback was also used.' : ''].filter(Boolean).join(' ')};
  }),more:Math.max(0,checks.length-40)};
}

function buildTaggingReport(video) {
  if (!video || video.id === 'batch') return null;
  const decision = object(video.taggingDecision), saved = object(video.taggingEvidence);
  const hasDecision = ['matched','ambiguous','unmatched','service-error'].includes(decision.status);
  // A saved parent alone, or a manually entered ID, is not a successful attempt.
  const hasMatch = id(saved.imdbID) && ['episode','movie','explicit-id'].includes(saved.kind);
  if (!hasDecision && !hasMatch && !video.autotag_tried) return null;
  const e = hasDecision ? object(decision.evidence) : hasMatch ? saved : {};
  const status = hasDecision ? decision.status : hasMatch ? 'matched' : 'unavailable';
  const matched = status === 'matched', reason = object(decision.reason);
  const report = {status, label:{matched:'Matched',ambiguous:'Needs a choice',unmatched:'Not matched',
    'service-error':'Attempt interrupted',unavailable:'Details unavailable'}[status], facts:[], notes:[], candidates:[]};
  const corrections=correctionDetails(e);
  report.corrections=corrections.items;report.moreCorrections=corrections.more;
  const fact = (label, value) => {if (present(value)) report.facts.push({label,value:text(value)});};
  const original = object(e.original), input = object(e.input);
  const recordIdentity = object(object(e.identities).record);
  if (matched) {
    report.summary = recordIdentity.origin === 'user' ? 'Tags were applied from a record you selected.' :
      e.kind === 'explicit-id' || object(e.lookup).kind === 'explicit-id' ? 'Tags were refreshed using an existing IMDb ID.' :
        'The proposed record passed the automatic tagging checks and its tags were applied.';
    if (recordIdentity.origin === 'legacy') report.notes.push('The original source of the stored IMDb ID is unknown.');
    if (object(e.lookup).kind === 'explicit-id') report.notes.push('This was an IMDb ID refresh. Retained title and numbering evidence can come from the original match.');
    if (id(e.imdbID) !== id(video.imdbID)) report.notes.push('The current IMDb ID differs from this saved match. This report describes the earlier result.');
  } else if (status === 'unavailable') {
    report.summary = 'An autotag attempt was recorded, but no detailed outcome was saved with this video.';
    report.notes.push('Current tags alone cannot tell us how that attempt ended. A new attempt will save a detailed report.');
    return report;
  } else {
    [report.summary, report.nextStep] = failureExplanation(status, reason);
    if (id(video.imdbID)) report.notes.push('This attempt did not apply a new match. The video currently has an IMDb ID from another selection or attempt.');
    // Service errors get a safe, actionable explanation rather than a raw error.
    const detail = message(reason.message);
    if (status !== 'service-error' && detail && ![report.summary,'Ambiguous results','No results','Not enough data','Episode mismatch'].includes(detail)) {
      fact('Recorded reason', detail);
    }
  }
  const source = Object.keys(original).length ? original : input;
  fact('Input title', source.title || e.originalTitle);
  fact('Input series', source.series);
  fact('Input year', source.year);
  fact('Input numbering', position(source));
  fact('Input file', source.filename);
  if (e.kind === 'movie' && recordLabel(e.candidate)) {
    fact('Search title', recordLabel(e.candidate));
    fact('Search title source', object(e.candidate).source);
  }
  if (position(e.requested)) fact('Episode lookup', position(e.requested));
  if (!present(source.season) && present(input.season)) fact('Inferred season', `Season ${text(input.season)} was used for the lookup.`);
  fact(matched ? 'Applied record' : 'Proposed record', recordLabel(e));
  if (e.matched && position(e.matched)) fact(matched ? 'Applied numbering' : 'Proposed numbering', position(e.matched));

  const parent = object(e.parentEvidence);
  const structure = object(object(e.structureAssessment).structure || e.structure || object(parent.support).structure);
  if (id(e.seriesID)) {
    const chosen = array(structure.candidates).find(c => c && c.seriesID === e.seriesID);
    fact(parent.confident ? 'Identified series' : 'Series candidate', chosen ? recordLabel(chosen) :
      [source.series, parent.catalogYear, id(e.seriesID)].filter(present).join(' · '));
    fact('Series evidence', parentDescription(parent));
    const witnesses = array(parent.support).filter(w => w && w.originalTitle && w.catalogTitle);
    if (witnesses.length) fact('Supporting episodes', witnesses.slice(0,3).map(w =>
      `“${text(w.originalTitle)}” → “${text(w.catalogTitle)}”`).join('; ') +
      (witnesses.length>3 ? `; ${witnesses.length-3} more recorded` : ''));
  }

  const title = object(e.titleAssessment), comparison = object(e.titleComparison);
  if (present(e.localTitle) && e.localTitle !== source.title) fact('Title used for comparison', e.localTitle);
  if (present(comparison.title) && comparison.title !== e.localTitle) fact('Normalized title', comparison.title);
  if (title.state) fact('Title check', [
    {compatible:'Passed',contradiction:'Conflicting',inconclusive:'Inconclusive'}[title.state] || 'Recorded',
    message(title.reason)].filter(Boolean).join(' — '));
  if (comparison.matched === true || (comparison.matched == null && e.exactTitle === true)) fact('Exact title check', 'The titles matched after the permitted normalization.');
  if (e.requested && e.matched && position(e.requested) !== position(e.matched)) {
    fact('Numbering correction', `${position(e.requested)} → ${position(e.matched)}${matched ? '.' : ' was proposed but not applied.'}`);
  }
  const runtime = object(e.runtimeAssessment), movie = object(e.movieAssessment || e.evaluation);
  const plausibility = object(movie.plausibility);
  const localRuntime = minutes(runtime.localMinutes || plausibility.localRuntimeMinutes);
  const catalogRuntime = minutes(runtime.omdbMinutes || plausibility.omdbRuntimeMinutes);
  if (localRuntime || catalogRuntime) fact('Runtime', `File: ${localRuntime || 'unknown'}; OMDb: ${catalogRuntime || 'unknown'}.`);
  if (movie.matchKind) fact('Movie title check', {exact:'Exact title agreement.',fuzzy:'Fuzzy title agreement.',canonical:'Expanded or alternate title considered.'}[movie.matchKind] || 'Title comparison recorded.');
  if (movie.yearDifference != null) fact('Movie year check', Number(movie.yearDifference) === 0 ? 'The years agreed.' : `${text(movie.yearDifference)} year difference recorded.`);
  if (array(movie.reasons).length) fact('Movie checks', movie.reasons.map(message).filter(Boolean).join('; '));

  const order = object(e.orderAssessment);
  const mapping=object(e.numberingMapping);
  if (mapping.state) {
    fact('Sibling numbering evidence', mapping.state === 'established' ?
      `${new Set(array(mapping.support).map(a=>a.id)).size} distinct exact-title episodes support season offset ${Number(mapping.seasonOffset)>=0?'+':''}${text(mapping.seasonOffset)} and episode offset ${Number(mapping.episodeOffset)>=0?'+':''}${text(mapping.episodeOffset)} in this release and local season.` :
      message(mapping.reason) || `At least ${text(mapping.required) || 'two'} independent exact-title siblings are needed to establish a consistent offset.`);
  }
  if (order.accepted === false) fact('Numbering check', message(order.reason) || 'The episode order could not be verified.');
  else if (order.accepted === true) fact('Numbering check', {
    'individual-title':'The episode title supported the proposed record.',
    'consistent-named-siblings':'Named episodes in this season supported the numbering.',
    'confident-series-numbering':'The series was established and no numbering contradiction was recorded.',
    'catalog-position':'The catalog position passed the numbering checks.',
    'user-confirmed-record':'You confirmed this episode record.',
    'sibling-numbering':'Independent exact-title siblings established the numbering correction; this episode still passed its own title and runtime checks.'
  }[order.basis] || 'The numbering check passed.');
  const numbering = object(order.numberingEvidence);
  if (array(numbering.local).length || array(numbering.catalog).length) fact('Numbering conflict',
    `Local episodes: ${numbers(numbering.local) || 'unknown'}; catalog episodes: ${numbers(numbering.catalog) || 'unknown'}.`);
  const orderWitnesses = array(order.support).filter(w => w &&
    (w.localEpisode !== w.catalogEpisode || w.localSeason !== w.catalogSeason));
  if (orderWitnesses.length) fact('Conflicting episodes', orderWitnesses.slice(0,3).map(w =>
    `“${text(w.originalTitle || w.catalogTitle)}”: ${position({season:w.localSeason,episode:w.localEpisode})} → ${position({season:w.catalogSeason,episode:w.catalogEpisode})}`).join('; '));

  const profile = object(structure.profile);
  if (array(profile.seasons).length) fact('Local season counts', profile.seasons.filter(s => s && typeof s === 'object').slice(0,12).map(s =>
    `Season ${text(s.season)}: episode numbers ${numbers(s.positions) || 'unknown'}`).join('; ') + '. Duplicate files do not add episode numbers.');
  if (profile.inferredSeason) fact('Season inference', 'Season 1 was considered because the files did not specify a season.');
  const comparisons = array(structure.comparisons);
  if (comparisons.length) fact('Season evidence', [...new Set(comparisons.map(c => ({
    'exceeds-alternative':'Local numbering exceeds an alternative’s reported season or episode total.',
    'two-season-counts':'Episode totals in at least two seasons favored this series over a longer alternative.',
    'positive-season-count':'A complete local season matched this series’ reported episode total while an alternative’s total was unknown.'
  }[object(c).basis])).filter(Boolean))].join(' '));
  if (structure.basis === 'ambiguous-season-structure') fact('Season evidence', 'The recorded season comparison did not resolve the competing series. An exact total in one season alone does not distinguish it from an incomplete copy of a known longer season.');

  const structuralCandidates = array(structure.candidates);
  const candidates = structuralCandidates.length ? structuralCandidates : array(object(e.discovery).candidates);
  report.candidateHeading = structuralCandidates.length ? 'Series compared' : 'Candidates returned';
  report.candidates = candidates.slice(0,20).map(c => ({label:recordLabel(c), detail:candidateDescription(c),
    selected:Boolean(structure.selectedID && object(c).seriesID === structure.selectedID)})).filter(c => c.label);
  report.moreCandidates = Math.max(0,candidates.length-20);
  return report;
}

module.exports = {buildTaggingReport};
