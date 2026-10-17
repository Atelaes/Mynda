// Browser-safe identity operations shared by transport, matching, persistence and
// the editor. Native IDs are opaque and always scoped by provider. IMDb remains
// an optional cross-reference and a supported lookup for legacy libraries.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const imdb = value => typeof value === 'string' && /^tt\d+$/.test(value.trim());

function native(value) {
  if (!object(value) || !Object.keys(value).every(key => ['provider','id'].includes(key)) ||
      typeof value.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider) ||
      typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)) return null;
  return {provider:value.provider, id:value.id};
}
function keyFromRef(value) {
  const ref = native(value);
  return ref ? `${ref.provider}:${ref.id}` : '';
}
function lookup(value) {
  const ref = native(value);
  if (ref) return ref;
  if (object(value) && Object.keys(value).every(key => ['externalSource','id'].includes(key)) &&
      value.externalSource === 'imdb' && imdb(value.id)) return {externalSource:'imdb', id:value.id.trim()};
  if (imdb(value)) return {externalSource:'imdb', id:value.trim()};
  if (typeof value !== 'string') return null;
  // Split only the provider prefix; an adapter may namespace its opaque IDs.
  const colon = value.indexOf(':');
  return colon > 0 ? native({provider:value.slice(0,colon), id:value.slice(colon+1)}) : null;
}
const valid = value => Boolean(lookup(value));
function recordKey(record) {
  return keyFromRef(record && record.catalogRef) || (imdb(record && record.imdbID) ? record.imdbID.trim() : '');
}
function parentKey(record) {
  return keyFromRef(record && record.catalogSeriesRef) ||
    (valid(record && record.seriesID) ? record.seriesID : imdb(record && record.seriesImdbID) ? record.seriesImdbID.trim() : '');
}
function matches(record, requested, parent = false) {
  const ref = lookup(requested);
  if (!ref || !record) return false;
  if (ref.externalSource) {
    const external = parent ? record.seriesImdbID || record.seriesID : record.imdbID;
    return imdb(external) && external.trim() === ref.id;
  }
  return keyFromRef(ref) === keyFromRef(parent ? record.catalogSeriesRef : record.catalogRef);
}
const matchesRecord = (record, requested) => matches(record,requested);
const matchesParent = (record, requested) => matches(record,requested,true);
function sameRecord(a, b) {
  const left = native(a && a.catalogRef), right = native(b && b.catalogRef);
  if (left && right && left.provider === right.provider) return left.id === right.id;
  return imdb(a && a.imdbID) && imdb(b && b.imdbID) && a.imdbID.trim() === b.imdbID.trim();
}
function recordFields(record) {
  return {catalogRef:native(record && record.catalogRef), imdbID:imdb(record && record.imdbID) ? record.imdbID.trim() : ''};
}
function parentFields(id, imdbID) {
  return {catalogSeriesRef:native(lookup(id)), seriesImdbID:imdb(imdbID) ? imdbID.trim() : imdb(id) ? id.trim() : ''};
}

// Collapse legacy declarations only when a single native parent explicitly
// supplies that IMDb cross-reference. Conflicting native parents stay distinct.
function parentKeys(records) {
  const aliases = new Map();
  for (const record of records) {
    const key = keyFromRef(record.catalogSeriesRef);
    if (!key || !imdb(record.seriesImdbID)) continue;
    if (!aliases.has(record.seriesImdbID)) aliases.set(record.seriesImdbID,new Set());
    aliases.get(record.seriesImdbID).add(key);
  }
  return [...new Set(records.map(parentKey).filter(Boolean).map(key =>
    aliases.get(key)?.size === 1 ? [...aliases.get(key)][0] : key))];
}
module.exports = {native,imdb,lookup,valid,keyFromRef,recordKey,parentKey,parentKeys,
  matchesRecord,matchesParent,sameRecord,recordFields,parentFields};
