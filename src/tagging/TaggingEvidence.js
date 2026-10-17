const CatalogIdentity = require('./CatalogIdentity');
// Durable, serializable observations. "Stored" describes where an ID was read,
// not who chose it. Legacy IDs have unknown provenance, never invented authorship.
const {validImdbID} = require('./CatalogResponse');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function snapshot(video = {}) {
  const result = {};
  for (const field of ['id','filename','kind','title','series','year','season','episode','imdbID','seriesImdbID','catalogRef','catalogSeriesRef','dvd']) {
    if (video[field] !== undefined) result[field] = copy(video[field]);
  }
  if (video.metadata && video.metadata.duration != null) result.durationSeconds = video.metadata.duration;
  return result;
}

function priorFor(video) {
  const prior = video && video.taggingEvidence;
  // A typed ID records authorship before any lookup succeeds. Only completed
  // matches may supply historical match details when that ID is refreshed.
  return prior && (prior.recordID || prior.imdbID) && CatalogIdentity.matchesRecord(video,prior.recordID || prior.imdbID) &&
    ['movie','episode','explicit-id'].includes(prior.kind) ? prior : null;
}

function identity(video, field, source) {
  const value = field==='seriesImdbID' ? CatalogIdentity.parentKey(video) : CatalogIdentity.recordKey(video);
  if (source === 'user') return {value, origin:'user', basis:'explicit-selection'};
  const prior = video && video.taggingEvidence;
  const name = field === 'seriesImdbID' ? 'series' : 'record';
  const saved = prior && prior.identities && prior.identities[name];
  if (saved && (name==='record' ? CatalogIdentity.matchesRecord(video,saved.value) : CatalogIdentity.matchesParent(video,saved.value)) &&
      ['automatic','user','legacy'].includes(saved.origin)) return {...copy(saved),value};
  // Read the first fix80 evidence format without losing known automatic origin.
  if (prior && CatalogIdentity.matchesRecord(video,prior.recordID || prior.imdbID) && ['movie','episode'].includes(prior.kind) &&
      (name === 'record' || CatalogIdentity.matchesParent(video,prior.seriesID))) return {value, origin:'automatic', basis:prior.kind};
  return {value, origin:'legacy', basis:'stored-id-origin-unknown'};
}

function storedParent(video) {
  const id = identity(video,'seriesImdbID');
  const prior = video.taggingEvidence;
  if (id.origin === 'automatic' && prior && CatalogIdentity.matchesParent(video,prior.seriesID) && prior.parentEvidence) {
    return {...copy(prior.parentEvidence), origin:'automatic', reuse:'stored', seriesID:id.value};
  }
  return {basis:'stored-series-id', origin:id.origin, confident:true, seriesID:id.value};
}

function selectedParent(video, seriesID, context) {
  const source = context.seriesSelectionSource;
  if (source === 'stored' && CatalogIdentity.matchesParent(video,seriesID)) return storedParent(video);
  if (source === 'stored' && context.parentEvidence) {
    return {basis:'stored-parent-id',confident:true,seriesID,...copy(context.parentEvidence)};
  }
  return {basis:source+'-series-selection', origin:source === 'user' ? 'user' : source === 'stored' ? 'legacy' : 'automatic',
    confident:true, seriesID,
    support:copy(context.parentEvidence || [])};
}

function witness(video, record, requested, matched) {
  return {videoID:video.id, filename:video.filename, originalTitle:video.title,
    catalogTitle:record.Title, seriesID:CatalogIdentity.parentKey(record), imdbID:record.imdbID,
    recordID:CatalogIdentity.recordKey(record),catalogRef:CatalogIdentity.native(record.catalogRef),
    requested:copy(requested), matched:copy(matched)};
}

function envelope(video, detail = {}, context = {}) {
  const prior = priorFor(video);
  const refreshing = detail.kind === 'explicit-id';
  const original = refreshing && prior ? prior.original || {
    ...snapshot(video),title:prior.originalTitle || video.title,...prior.requested
  } : context.originalInput || snapshot(video);
  const retained = refreshing && prior ? copy(prior) : {};
  const selected = CatalogIdentity.valid(context.selectedSeriesID) ? {
    seriesID:context.selectedSeriesID,
    parentEvidence:selectedParent(video,context.selectedSeriesID,context)
  } : {};
  return {...retained, version:85, schemaVersion:2, original:copy(original),...selected,
    input:snapshot(video), ...copy(detail),
    ...(refreshing && prior ? {kind:prior.kind, lookup:copy(detail)} : {}),
    ...(context.correctionChecks && context.correctionChecks.length ? {correctionChecks:copy(context.correctionChecks)} : {}),
    requests:copy(context.requestTrace || []),
    requestBudget:context.requestBudget ? copy(context.requestBudget) : undefined};
}

function forMatch(video, record = {}, detail = {}, context) {
  record = record || {};
  const evidence = envelope(video,detail,context);
  const refreshing = detail.kind === 'explicit-id';
  const recordIdentity = context && context.recordSelectionSource === 'user' ?
    {value:CatalogIdentity.recordKey(record),origin:'user',basis:'confirmed-discovery-candidate'} : refreshing ? identity(video,'imdbID',detail.source) :
    {value:CatalogIdentity.recordKey(record), origin:'automatic', basis:detail.kind};
  const seriesID = CatalogIdentity.parentKey(record) || detail.seriesID;
  evidence.imdbID = record.imdbID;
  evidence.recordID = CatalogIdentity.recordKey(record);
  evidence.catalogRef = CatalogIdentity.native(record.catalogRef);
  evidence.catalogSeriesRef = CatalogIdentity.native(record.catalogSeriesRef);
  evidence.catalogTitle = record.Title;
  evidence.identities = {record:{...recordIdentity,value:CatalogIdentity.recordKey(record)}};
  if (CatalogIdentity.valid(seriesID)) {
    evidence.seriesID = seriesID;
    const prior = video.taggingEvidence;
    evidence.identities.series = refreshing && prior && CatalogIdentity.matchesParent(record,prior.seriesID) ?
      {...identity(video,'seriesImdbID'),value:seriesID} :
      {value:seriesID, origin:detail.parentEvidence && detail.parentEvidence.origin ||
        (refreshing && detail.source === 'user' ? 'user' : 'automatic'),
        basis:detail.parentEvidence && detail.parentEvidence.basis || 'episode-record'};
  }
  return evidence;
}

function markUserEdit(video, changes) {
  if (changes.taggingEvidence) return video; // An applied result supplies its own provenance.
  const fields = ['imdbID','seriesImdbID'].filter(field => Object.prototype.hasOwnProperty.call(changes,field));
  const parentEdited=Object.hasOwn(changes,'series') || (Object.hasOwn(changes,'kind') && changes.kind!=='show');
  if(parentEdited && !Object.hasOwn(changes,'catalogSeriesRef'))video={...video,catalogSeriesRef:null,seriesImdbID:''};
  if(fields.includes('imdbID'))video={...video,catalogRef:null,ratings:{user:video.ratings?.user ?? '',imdb:'',rt:'',mc:''}};
  if(fields.includes('seriesImdbID'))video={...video,catalogSeriesRef:null};
  if (!fields.length) return video;
  const replacing = fields.includes('imdbID') && video.taggingEvidence && video.taggingEvidence.imdbID !== changes.imdbID;
  const evidence = copy(!replacing && video.taggingEvidence || {version:85,schemaVersion:2,original:snapshot(video)});
  evidence.identities = evidence.identities || {};
  for (const field of fields) {
    const name = field === 'imdbID' ? 'record' : 'series';
    if (validImdbID(changes[field])) evidence.identities[name] = {value:changes[field].trim(),origin:'user',basis:'editor-entry'};
    else delete evidence.identities[name];
  }
  if (fields.includes('imdbID')) {evidence.imdbID=video.imdbID;evidence.recordID=CatalogIdentity.recordKey(video);evidence.catalogRef=null;}
  return {...video,taggingEvidence:evidence};
}

function assignParent(video,seriesID,parentEvidence) {
  const prior = copy(video.taggingEvidence || {version:85,schemaVersion:2,original:snapshot(video)});
  return {...video,...CatalogIdentity.parentFields(seriesID),taggingEvidence:{...prior,seriesID,parentEvidence:copy(parentEvidence),
    identities:{...prior.identities,series:{value:seriesID,origin:parentEvidence.origin,basis:parentEvidence.basis}}}};
}

module.exports = {copy,snapshot,identity,priorFor,storedParent,selectedParent,witness,envelope,forMatch,markUserEdit,assignParent};
