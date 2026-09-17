// Durable, serializable observations. "Stored" describes where an ID was read,
// not who chose it. Legacy IDs have unknown provenance, never invented authorship.
const {validImdbID} = require('./CatalogResponse');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function snapshot(video = {}) {
  const result = {};
  for (const field of ['id','filename','kind','title','series','year','season','episode','imdbID','seriesImdbID','dvd']) {
    if (video[field] !== undefined) result[field] = video[field];
  }
  if (video.metadata && video.metadata.duration != null) result.durationSeconds = video.metadata.duration;
  return result;
}

function priorFor(video) {
  const prior = video && video.taggingEvidence;
  return prior && prior.imdbID === video.imdbID ? prior : null;
}

function identity(video, field, source) {
  const value = String(video && video[field] || '').trim();
  if (source === 'user') return {value, origin:'user', basis:'explicit-selection'};
  const prior = video && video.taggingEvidence;
  const name = field === 'seriesImdbID' ? 'series' : 'record';
  const saved = prior && prior.identities && prior.identities[name];
  if (saved && saved.value === value && ['automatic','user','legacy'].includes(saved.origin)) return copy(saved);
  // Read the first fix80 evidence format without losing known automatic origin.
  if (prior && prior.imdbID === video.imdbID && ['movie','episode'].includes(prior.kind) &&
      (name === 'record' || prior.seriesID === value)) return {value, origin:'automatic', basis:prior.kind};
  return {value, origin:'legacy', basis:'stored-id-origin-unknown'};
}

function storedParent(video) {
  const id = identity(video,'seriesImdbID');
  const prior = video.taggingEvidence;
  if (id.origin === 'automatic' && prior && prior.seriesID === id.value && prior.parentEvidence) {
    return {...copy(prior.parentEvidence), origin:'automatic', reuse:'stored', seriesID:id.value};
  }
  return {basis:'stored-series-id', origin:id.origin, confident:true, seriesID:id.value};
}

function selectedParent(video, seriesID, context) {
  const source = context.seriesSelectionSource;
  if (source === 'stored' && seriesID === video.seriesImdbID) return storedParent(video);
  if (source === 'stored' && context.parentEvidence) {
    return {basis:'stored-parent-id',confident:true,seriesID,...copy(context.parentEvidence)};
  }
  return {basis:source+'-series-selection', origin:source === 'user' ? 'user' : source === 'stored' ? 'legacy' : 'automatic',
    confident:true, seriesID,
    support:copy(context.parentEvidence || [])};
}

function witness(video, record, requested, matched) {
  return {videoID:video.id, filename:video.filename, originalTitle:video.title,
    catalogTitle:record.Title, seriesID:record.seriesID, imdbID:record.imdbID,
    requested:copy(requested), matched:copy(matched)};
}

function envelope(video, detail = {}, context = {}) {
  const prior = priorFor(video);
  const refreshing = detail.kind === 'explicit-id';
  const original = refreshing && prior ? prior.original || {
    ...snapshot(video),title:prior.originalTitle || video.title,...prior.requested
  } : context.originalInput || snapshot(video);
  const retained = refreshing && prior ? copy(prior) : {};
  const selected = validImdbID(context.selectedSeriesID) ? {
    seriesID:context.selectedSeriesID,
    parentEvidence:selectedParent(video,context.selectedSeriesID,context)
  } : {};
  return {...retained, version:83, schemaVersion:2, original:copy(original),...selected,
    input:snapshot(video), ...copy(detail),
    ...(refreshing && prior ? {kind:prior.kind, lookup:copy(detail)} : {}),
    requests:copy(context.requestTrace || []),
    requestBudget:context.requestBudget ? copy(context.requestBudget) : undefined};
}

function forMatch(video, record = {}, detail = {}, context) {
  record = record || {};
  const evidence = envelope(video,detail,context);
  const refreshing = detail.kind === 'explicit-id';
  const recordIdentity = context && context.recordSelectionSource === 'user' ?
    {value:record.imdbID,origin:'user',basis:'confirmed-discovery-candidate'} : refreshing ? identity(video,'imdbID',detail.source) :
    {value:record.imdbID, origin:'automatic', basis:detail.kind};
  const seriesID = record.seriesID || detail.seriesID;
  evidence.imdbID = record.imdbID;
  evidence.catalogTitle = record.Title;
  evidence.identities = {record:recordIdentity};
  if (validImdbID(seriesID)) {
    evidence.seriesID = seriesID;
    const prior = video.taggingEvidence;
    evidence.identities.series = refreshing && prior && prior.seriesID === seriesID ?
      identity({...video,seriesImdbID:seriesID},'seriesImdbID') :
      {value:seriesID, origin:detail.parentEvidence && detail.parentEvidence.origin ||
        (refreshing && detail.source === 'user' ? 'user' : 'automatic'),
        basis:detail.parentEvidence && detail.parentEvidence.basis || 'episode-record'};
  }
  return evidence;
}

function markUserEdit(video, changes) {
  if (changes.taggingEvidence) return video; // An applied result supplies its own provenance.
  const fields = ['imdbID','seriesImdbID'].filter(field => Object.prototype.hasOwnProperty.call(changes,field));
  if (!fields.length) return video;
  const replacing = fields.includes('imdbID') && video.taggingEvidence && video.taggingEvidence.imdbID !== changes.imdbID;
  const evidence = copy(!replacing && video.taggingEvidence || {version:83,schemaVersion:2,original:snapshot(video)});
  evidence.identities = evidence.identities || {};
  for (const field of fields) {
    const name = field === 'imdbID' ? 'record' : 'series';
    if (validImdbID(changes[field])) evidence.identities[name] = {value:changes[field].trim(),origin:'user',basis:'editor-entry'};
    else delete evidence.identities[name];
  }
  if (fields.includes('imdbID')) evidence.imdbID = video.imdbID;
  return {...video,taggingEvidence:evidence};
}

function assignParent(video,seriesID,parentEvidence) {
  const prior = copy(video.taggingEvidence || {version:83,schemaVersion:2,original:snapshot(video)});
  return {...video,seriesImdbID:seriesID,taggingEvidence:{...prior,seriesID,parentEvidence:copy(parentEvidence),
    identities:{...prior.identities,series:{value:seriesID,origin:parentEvidence.origin,basis:parentEvidence.basis}}}};
}

module.exports = {copy,snapshot,identity,priorFor,storedParent,selectedParent,witness,envelope,forMatch,markUserEdit,assignParent};
