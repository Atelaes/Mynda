// Parent identity belongs to a physical series collection. Episode order
// belongs to a season within one directory/release. Neither scope can turn a
// generated title or a dependent recovery into independent identity evidence.
const Match = require('./EpisodeMatch');
const {copy} = require('./TaggingEvidence');
const {normalizeEpisodeNumber,validSeriesImdbID} = require('./CatalogResponse');
const {scopeFor} = require('./SeriesCollection');
const {profileFor} = require('./SeriesStructure');
const Numbering = require('./EpisodeNumbering');

const directoryKey = video => {const scope = scopeFor(video); return scope && scope.directoryKey;};
const sorted = anchors => copy(anchors).sort((a,b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
});

function createEvidence(videos = [], savedVideos = []) {
  const collections = new Map(), directories = new Map();
  const selectedIDs=new Set(videos.map(v=>v.id));
  const selectedScopes=new Set(videos.map(scopeFor).filter(Boolean).map(s=>s.key));
  const savedSiblings=savedVideos.filter(v=>!selectedIDs.has(v.id) && selectedScopes.has(scopeFor(v)?.key));
  function collection(scope) {
    if (!collections.has(scope.key)) collections.set(scope.key,{anchors:[],parents:new Set(),years:new Set(),members:[]});
    return collections.get(scope.key);
  }
  // Inspect declarations before processing starts, including records that may
  // fail lookup later. Conflict handling must not depend on enumeration order.
  for (const video of [...videos,...savedSiblings]) {
    const scope = scopeFor(video);
    if (!scope) continue;
    const group = collection(scope);
    group.members.push(video);
    if (validSeriesImdbID(video.seriesImdbID)) group.parents.add(video.seriesImdbID.trim());
    scope.years.forEach(year => group.years.add(year));
  }

  function observe(video, result) {
    if (!result || result.status !== 'matched') return;
    const tagged = result.video, detail = result.evidence;
    const scope = scopeFor(video);
    if (!tagged || !scope || (detail && detail.kind !== 'episode')) return;
    const parent = tagged.seriesImdbID;
    if (!validSeriesImdbID(parent) || !/^tt\d+$/.test(tagged.imdbID || '')) return;
    const group = collection(scope);
    group.parents.add(parent);
    scope.years.forEach(year => group.years.add(year));
    const parentEvidence = detail && detail.parentEvidence || {};
    if (parentEvidence.catalogYear) group.years.add(parentEvidence.catalogYear);
    const original = detail && detail.original || video;
    const title = Match.usefulEpisodeTitle(original.title,original.series,{dvd:Boolean(original.dvd)});
    const comparison = Match.episodeTitleComparison(title,tagged.title,original.series);
    if (!title || !comparison.matched) return;
    const requested = detail && detail.requested || {season:video.season,episode:video.episode};
    const matched = detail && detail.matched || requested;
    const anchor = {
      parent,id:tagged.imdbID,videoID:video.id,filename:video.filename,
      directoryKey:scope.directoryKey,
      independentNumbering:Boolean(detail && !detail.numberingMapping &&
        detail.identities && detail.identities.record && detail.identities.record.origin === 'automatic' &&
        detail.identities.record.value === tagged.imdbID &&
        original.id === video.id && original.filename === video.filename && original.series === video.series &&
        normalizeEpisodeNumber(video.season) === normalizeEpisodeNumber(requested.season) &&
        normalizeEpisodeNumber(video.episode) === normalizeEpisodeNumber(requested.episode) &&
        (!detail.orderAssessment || detail.orderAssessment.basis !== 'user-confirmed-record')),
      originalTitle:original.title,catalogTitle:tagged.title,titleComparison:comparison,
      localSeason:normalizeEpisodeNumber(requested.season),
      localEpisode:normalizeEpisodeNumber(requested.episode),
      catalogSeason:normalizeEpisodeNumber(matched.season),
      catalogEpisode:normalizeEpisodeNumber(matched.episode)
    };
    if (Object.values(anchor).some(value => value === null)) return;
    if (!directories.has(scope.directoryKey)) directories.set(scope.directoryKey,[]);
    const add = list => {if (!list.some(item => JSON.stringify(item) === JSON.stringify(anchor))) list.push(anchor);};
    add(directories.get(scope.directoryKey));
    // A recovered named episode may verify local numbering, but its inherited
    // parent cannot become a new independent witness for collection identity.
    if (!detail?.numberingMapping && !['siblings-series-selection','batch-series-selection','structure-series-selection'].includes(parentEvidence.basis)) add(group.anchors);
  }

  // Reuse only intact, automatically accepted evidence. Current catalog titles
  // cannot substitute for an originally unnamed file; edits invalidate a vote.
  for (const video of savedSiblings) {
    const detail=video.taggingEvidence, original=detail && detail.original;
    if (!detail || !original || video.taggingDecision || detail.kind !== 'episode' ||
        detail.numberingMapping || detail.identities?.record?.origin !== 'automatic' ||
        detail.imdbID !== video.imdbID || detail.seriesID !== video.seriesImdbID ||
        detail.catalogTitle !== video.title || original.id !== video.id || original.filename !== video.filename ||
        original.series !== video.series || !detail.requested ||
        normalizeEpisodeNumber(video.season) !== normalizeEpisodeNumber(detail.requested.season) ||
        normalizeEpisodeNumber(video.episode) !== normalizeEpisodeNumber(detail.requested.episode)) continue;
    observe(video,{status:'matched',video,evidence:detail});
  }

  function parentFor(video, failure) {
    if (!canRetry(failure)) return null;
    if (Match.assessEpisodeTitle(video.title,'Episode #0.0',video.series).state === 'contradiction') return null;
    const scope = scopeFor(video);
    const group = scope && collections.get(scope.key);
    if (!group || !group.anchors.length || group.parents.size !== 1 || group.years.size > 1) return null;
    const parent = [...group.parents][0];
    if (video.seriesImdbID && video.seriesImdbID.trim() !== parent) return null;
    const choices = Array.isArray(failure.choices) ? failure.choices : [];
    const selected = choices.find(choice => choice.imdbID === parent);
    if (choices.length && !selected) return null;
    const candidateYear = selected && String(selected.Year || '').match(/^(?:19|20)\d{2}/);
    const knownYears = new Set([...group.years,...(candidateYear ? [candidateYear[0]] : [])]);
    if (knownYears.size > 1 || scope.years.some(year => !knownYears.has(year))) return null;
    return {seriesID:parent,evidence:sorted(group.anchors)};
  }

  function anchorsFor(video, result) {
    const {evidence} = result.candidate;
    if (evidence.kind !== 'episode') return [];
    return sorted((directories.get(directoryKey(video)) || [])
      .filter(anchor => anchor.localSeason === normalizeEpisodeNumber(evidence.requested.season)));
  }
  function structureGroups(pending) {
    const groups=new Map();
    for (const item of pending) {
      if (item.parent || !canRetry(item.result) || !Array.isArray(item.result.choices) || item.result.choices.length < 2) continue;
      const scope=scopeFor(item.video), group=scope && collections.get(scope.key);
      // Counts cannot overrule conflicting independently named episodes or
      // contradict explicit declarations, including failed input records.
      if (!group || group.anchors.length || group.parents.size > 1 || group.years.size > 1) continue;
      if (!groups.has(scope.key)) {
        const profile=profileFor(group.members);
        if (!profile) continue;
        groups.set(scope.key,{profile,pending:[]});
      }
      groups.get(scope.key).pending.push(item);
    }
    return [...groups.values()].sort((a,b)=>a.profile.key.localeCompare(b.profile.key));
  }
  function numberingFor(video,result) {
    if (video.kind !== 'show' || video.imdbID) return null;
    const scope=scopeFor(video), group=scope && collections.get(scope.key);
    if (!group || group.parents.size !== 1 || group.years.size > 1) return null;
    const seriesID=[...group.parents][0];
    const detail=result.status === 'candidate' ? result.candidate.evidence : result.evidence || {};
    if ((video.seriesImdbID && video.seriesImdbID !== seriesID) || (detail.seriesID && detail.seriesID !== seriesID)) return null;
    if (result.status === 'ambiguous' && (!parentFor(video,result) ||
        (result.choices || []).some(c=>c.imdbID === seriesID) === false)) return null;
    const assessment=Numbering.assess(video,seriesID,directories.get(scope.directoryKey) || [],detail.requested || video);
    // The same independent records prove both the parent and the offset. Do
    // not carry an earlier, inconclusive parent lookup into this new proposal.
    const parentEvidence=sorted(assessment.support);
    return {assessment,parentEvidence};
  }
  return {observe,parentFor,anchorsFor,structureGroups,numberingFor};
}

function canRetry(result) {
  return result && ['ambiguous','unmatched'].includes(result.status) && result.reason &&
    ['ambiguous-series','unconfirmed-series'].includes(result.reason.code);
}
module.exports = {createEvidence,directoryKey,canRetry};
