'use strict';

// Backend-only acceptance and mutation rules. Renderer clients import the
// browser-safe protocol, never scanner/subtitle normalization dependencies.
const _ = require('lodash');
const {trackManualSubtitleEdit} = require('../scanning/SubtitleMatcher');
const {applyScanOperation} = require('./LibraryScanOperations');
const protocol = require('./LibraryProtocol');
const {ROOTS, FORBIDDEN, failure, parts, getAt, setAt, expectation, diffFields,
  encodePatch, assertExpected} = protocol;
const IDENTITY_FIELDS = ['kind', 'title', 'year', 'imdbID', 'series', 'seriesImdbID', 'season', 'episode'];

function applyFields(record, fields, actor) {
  let next = record;
  for (const field of fields) {
    parts(field.path);
    if (FORBIDDEN.has(field.path) || field.path === 'id' || field.path.startsWith('id.')) throw failure('INVALID_LIBRARY_OPERATION', 'Video identity cannot be changed.');
    if (actor === 'renderer' && ['duplicates', 'filename', 'metadata', 'dvd', 'detected_subtitles', 'manual_subtitles', 'ignored_subtitles', 'subtitle_tracking_initialized'].some(key => field.path === key || field.path.startsWith(key + '.'))) {
      throw failure('INVALID_LIBRARY_OPERATION', 'This field is maintained by the library scanner.');
    }
    const current = getAt(record, field.path);
    // A repeated identical set is safe and idempotent, even if its baseline is old.
    if (_.isEqual(current, field.remove ? undefined : field.value)) continue;
    assertExpected(current, field.expected, field.path, record.id);
    next = setAt(next, field.path, _.cloneDeep(field.value), field.remove);
  }
  if (actor === 'renderer' && fields.some(field => field.path === 'subtitles')) {
    next = trackManualSubtitleEdit(record, _.cloneDeep(next));
  }
  return next;
}
function applyOperations(initial, operations, options = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 10000) throw failure('INVALID_LIBRARY_OPERATION', 'A nonempty, bounded operation list is required.');
  let data = initial;
  const addresses = new Set(), skipped = [], edited = [];
  for (const op of operations) {
    if (['upsert-media', 'move-media', 'remove-watchfolder'].includes(op.opType)) {
      if (options.actor === 'renderer') throw failure('INVALID_LIBRARY_OPERATION', 'This operation belongs to the backend.');
      data = applyScanOperation(data, op);
      ['media', 'inactive_media', 'settings'].forEach(key => { if (data[key] !== initial[key]) addresses.add(key); });
      continue;
    }
    if (op.opType === 'record-played') {
      if (typeof op.id !== 'string') throw failure('INVALID_LIBRARY_OPERATION', 'A video ID is required.');
      data = {...data, recently_watched: [op.id, ...data.recently_watched.filter(id => id !== op.id)].slice(0, 10)};
      addresses.add('recently_watched');
      continue;
    }
    if (op.opType === 'patch-watchfolder') {
      if (options.actor === 'renderer' && op.fields.some(field => field.path !== 'kind')) throw failure('INVALID_LIBRARY_OPERATION', 'Only the watchfolder kind can be edited here.');
      const index = data.settings.watchfolders.findIndex(folder => folder.path === op.path);
      if (index < 0) throw failure('LIBRARY_CONFLICT', 'The watchfolder no longer exists.');
      const next = applyFields(data.settings.watchfolders[index], op.fields, 'backend');
      data = setAt(data, ['settings', 'watchfolders', String(index)], next);
      addresses.add('settings.watchfolders');
      continue;
    }
    if (op.opType === 'patch-media') {
      const seen = new Set();
      for (const patch of op.patches) {
        if (seen.has(patch.id)) throw failure('INVALID_LIBRARY_OPERATION', 'A transaction cannot patch the same video twice.');
        seen.add(patch.id);
        try {
          const index = data.media.findIndex(video => video && video.id === patch.id);
          if (index < 0) throw failure('LIBRARY_CONFLICT', 'The video is no longer in the active library.', {id: patch.id});
          const old = data.media[index];
          for (const guard of patch.guards || []) assertExpected(getAt(old, guard.path), guard.expected, guard.path, patch.id);
          const editsIdentity = patch.fields.some(field => IDENTITY_FIELDS.includes(field.path));
          if ((options.coherent || (options.actor === 'renderer' && editsIdentity)) && patch.baseline) {
            for (const field of IDENTITY_FIELDS) assertExpected(old[field], expectation(patch.baseline[field]), field, patch.id);
          }
          let next = applyFields(old, patch.fields, options.actor);
          if (next.kind !== 'show' && next.seriesImdbID) next = {...next, seriesImdbID: ''};
          if (next !== old) {
            data = setAt(data, ['media', String(index)], next);
            edited.push(next);
            addresses.add(`media.id=${patch.id}`);
          }
        } catch (error) {
          if (options.conflict !== 'skip' || error.code !== 'LIBRARY_CONFLICT') throw error;
          skipped.push({id: patch.id, code: error.code, address: error.address, message: error.message});
          if (options.source === 'autotag') {
            const currentIndex = data.media.findIndex(video => video && video.id === patch.id);
            if (currentIndex >= 0) {
              const current = data.media[currentIndex];
              const taggingDecision = {status: 'unmatched', reason: {code: 'changed-during-lookup',
                message: 'This video changed while Auto-Tag was looking it up. The proposed tags were not applied.'},
                evidence: {saveConflict: {fields: error.address ? [error.address] : [], retryable: true}}};
              data = setAt(data, ['media', String(currentIndex)], {...current, taggingDecision});
              addresses.add(`media.id=${patch.id}`);
            }
          }
        }
      }
      continue;
    }
    if (!['add', 'replace', 'remove'].includes(op.opType)) throw failure('INVALID_LIBRARY_OPERATION', 'Unrecognized library operation.');
    const keys = parts(op.address);
    if (!ROOTS.has(keys[0])) throw failure('INVALID_LIBRARY_OPERATION', 'This library section cannot be changed.');
    if (options.actor === 'renderer' && keys[0] === 'settings' &&
        !['preferences', 'used', 'themes'].includes(keys[1])) {
      throw failure('INVALID_LIBRARY_OPERATION', 'Watchfolders must be changed through their native controls.');
    }
    if (options.actor === 'renderer' && ['media', 'inactive_media'].includes(keys[0])) {
      if (op.opType !== 'replace' || keys[0] !== 'media' || keys.length < 2) throw failure('INVALID_LIBRARY_OPERATION', 'Video changes must use field patches.');
      const recordPath = keys.slice(0, 2), oldRecord = getAt(data, recordPath);
      const oldValue = getAt(data, keys);
      assertExpected(oldValue, op.check, op.address);
      const changes = keys.length === 2 ? diffFields(oldRecord, op.entry) : {[keys.slice(2).join('.')]: op.entry};
      if (op.recordBaseline && Object.keys(changes).some(field => IDENTITY_FIELDS.includes(field))) {
        for (const field of IDENTITY_FIELDS) assertExpected(oldRecord[field], expectation(op.recordBaseline[field]), field, oldRecord.id);
      }
      const patch = encodePatch({id: oldRecord.id, baseline: oldRecord, changes});
      const next = applyFields(oldRecord, patch.fields, 'renderer');
      data = setAt(data, recordPath, next);
      addresses.add(op.address);
      continue;
    }
    if (op.opType === 'add' && keys[keys.length - 1] === 'push') {
      const parent = keys.slice(0, -1), array = getAt(data, parent);
      if (!Array.isArray(array)) throw failure('INVALID_LIBRARY_OPERATION', 'Push requires an array.');
      if (op.entry && op.entry.id && array.some(item => item && item.id === op.entry.id)) throw failure('LIBRARY_CONFLICT', 'This record already exists.');
      data = setAt(data, parent, [...array, _.cloneDeep(op.entry)]);
    } else {
      const old = getAt(data, keys);
      assertExpected(old, op.check, op.address);
      if (op.opType === 'add' && old !== undefined) throw failure('LIBRARY_CONFLICT', 'This value already exists.');
      data = setAt(data, keys, _.cloneDeep(op.entry), op.opType === 'remove');
    }
    addresses.add(op.address);
  }
  if (options.updateUsedLists && edited.length) {
    const used = {...data.settings.used};
    for (const [key, videoKey] of [['tags', 'tags'], ['genres', 'genre']]) {
      used[key] = [...new Set([...(used[key] || []), ...edited.flatMap(video => Array.isArray(video[videoKey]) ? video[videoKey] : typeof video[videoKey] === 'string' && video[videoKey] ? [video[videoKey]] : [])])].sort();
    }
    data = {...data, settings: {...data.settings, used}};
    addresses.add('settings.used');
  }
  return {data, addresses: [...addresses], skipped, conflicts: skipped};
}
module.exports = {...protocol, applyOperations};
