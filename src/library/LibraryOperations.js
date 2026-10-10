'use strict';

// Pure library transactions. Neither Electron nor filesystem access belongs here.
const _ = require('lodash');
const {trackManualSubtitleEdit} = require('../scanning/SubtitleMatcher');
const {applyScanOperation} = require('./LibraryScanOperations');
const ROOTS = new Set(['media', 'inactive_media', 'settings', 'playlists', 'recently_watched']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTITY_FIELDS = ['kind', 'title', 'year', 'imdbID', 'series', 'seriesImdbID', 'season', 'episode'];

function failure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) Object.assign(error, details);
  return error;
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
function parts(address) {
  if (typeof address !== 'string' || !address) throw failure('INVALID_LIBRARY_OPERATION', 'A library address is required.');
  const result = address.split('.');
  if (result.some(key => !key || FORBIDDEN.has(key))) throw failure('INVALID_LIBRARY_OPERATION', 'Unsafe library address.');
  return result;
}
function keyAt(container, key) {
  if (!Array.isArray(container)) return key;
  if (key.startsWith('id=')) {
    const index = container.findIndex(item => item && item.id === key.slice(3));
    if (index < 0) throw failure('LIBRARY_CONFLICT', 'The requested record no longer exists.');
    return index;
  }
  if (!/^\d+$/.test(key) || Number(key) >= container.length) {
    throw failure('LIBRARY_CONFLICT', 'The requested array entry no longer exists.');
  }
  return Number(key);
}
function getAt(object, path) {
  let value = object;
  for (const part of typeof path === 'string' ? parts(path) : path) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[keyAt(value, part)];
  }
  return value;
}
function setAt(object, path, value, remove = false) {
  const keys = typeof path === 'string' ? parts(path) : path;
  if (!keys.length) return value;
  const source = object == null ? {} : object;
  const key = keyAt(source, keys[0]);
  const copy = Array.isArray(source) ? source.slice() : {...source};
  if (keys.length > 1) copy[key] = setAt(source[key], keys.slice(1), value, remove);
  else if (remove) {
    if (Array.isArray(copy)) copy.splice(key, 1);
    else delete copy[key];
  } else copy[key] = value;
  return copy;
}
function expectation(value) { return value === undefined ? {present: false} : {present: true, value: _.cloneDeep(value)}; }
function matches(actual, expected) {
  return expected.present ? _.isEqual(actual, expected.value) : actual === undefined;
}
function diffFields(before, after, prefix = '', changes = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (FORBIDDEN.has(key)) throw failure('INVALID_LIBRARY_OPERATION', 'Unsafe record property.');
    const left = before && before[key], right = after && after[key];
    const address = prefix ? `${prefix}.${key}` : key;
    if (_.isEqual(left, right)) continue;
    if (_.isPlainObject(left) && _.isPlainObject(right)) diffFields(left, right, address, changes);
    else changes[address] = _.cloneDeep(right);
  }
  return changes;
}
function encodePatch(patch) {
  if (!patch || typeof patch.id !== 'string' || !patch.id) throw failure('INVALID_LIBRARY_OPERATION', 'A video ID is required.');
  const changes = patch.changes || diffFields(patch.baseline || {}, patch.replacement || {});
  const expected = patch.expected || {};
  const fields = Object.keys(changes).map(path => {
    parts(path);
    if (path === 'id' || path.startsWith('id.')) throw failure('INVALID_LIBRARY_OPERATION', 'Video identity cannot be replaced.');
    const old = Object.prototype.hasOwnProperty.call(expected, path) ? expected[path] :
      patch.baseline ? getAt(patch.baseline, path) : undefined;
    return {path, value: _.cloneDeep(changes[path]), remove: changes[path] === undefined, expected: expectation(old)};
  });
  return {id: patch.id, fields, guards: Object.keys(expected).filter(path => !Object.prototype.hasOwnProperty.call(changes, path)).map(path => ({path, expected: expectation(expected[path])})), baseline: patch.baseline ? _.cloneDeep(patch.baseline) : undefined};
}
function prepareOperation(data, supplied) {
  const op = _.cloneDeep(supplied);
  if (op.opType === 'patch-media') {
    op.patches = op.patches.map(patch => patch.fields ? patch : encodePatch({...patch, baseline: patch.baseline || data.media.find(video => video && video.id === patch.id)}));
    return op;
  }
  if (op.opType === 'patch-watchfolder') {
    const old = data.settings.watchfolders.find(folder => folder.path === op.path);
    if (!old) throw failure('LIBRARY_CONFLICT', 'The watchfolder no longer exists.');
    op.fields = Object.keys(op.changes).map(path => ({path, value: op.changes[path], remove: op.changes[path] === undefined,
      expected: expectation(Object.prototype.hasOwnProperty.call(op.expected || {}, path) ? op.expected[path] : getAt(old, path))}));
    delete op.changes; delete op.expected;
    return op;
  }
  if (!['add', 'replace', 'remove'].includes(op.opType)) return op;
  const keys = parts(op.address);
  if (!ROOTS.has(keys[0])) throw failure('INVALID_LIBRARY_OPERATION', 'This library section cannot be changed.');
  // Array indices supplied by legacy UI callers become stable record selectors.
  let current = data;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'push' && i === keys.length - 1 && op.opType === 'add') break;
    if (current == null) break;
    const resolved = keyAt(current, key);
    if (Array.isArray(current) && current[resolved] && typeof current[resolved].id === 'string') keys[i] = `id=${current[resolved].id}`;
    current = current[resolved];
  }
  op.address = keys.join('.');
  if (op.opType === 'replace' && keys[0] === 'media' && keys.length >= 2) op.recordBaseline = _.cloneDeep(getAt(data, keys.slice(0, 2)));
  if (!op.check && !(op.opType === 'add' && keys[keys.length - 1] === 'push')) {
    op.check = expectation(Object.prototype.hasOwnProperty.call(op, 'expected') ? op.expected : getAt(data, keys));
  }
  delete op.expected;
  return op;
}
function assertExpected(actual, check, address, id) {
  if (check && !matches(actual, check)) throw failure('LIBRARY_CONFLICT',
    'This item changed while the edit was being prepared. Your unsaved edit has been kept.', {address, id});
}
function applyFields(record, fields, actor) {
  let next = record;
  for (const field of fields) {
    parts(field.path);
    if (FORBIDDEN.has(field.path) || field.path === 'id' || field.path.startsWith('id.')) throw failure('INVALID_LIBRARY_OPERATION', 'Video identity cannot be changed.');
    if (actor === 'renderer' && ['duplicates', 'filename', 'metadata', 'detected_subtitles', 'manual_subtitles', 'ignored_subtitles', 'subtitle_tracking_initialized'].some(key => field.path === key || field.path.startsWith(key + '.'))) {
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
function makeDelta(before, after) {
  const delta = {sections: {}, records: {}};
  for (const key of Object.keys(after)) {
    if (before[key] === after[key]) continue;
    if (key === 'media' || key === 'inactive_media') {
      // Older libraries may retain null deletion placeholders or repeated IDs.
      // A full section replacement preserves them exactly until explicitly cleaned.
      const safeRecords = array => Array.isArray(array) && array.every(video => video && typeof video.id === 'string') && new Set(array.map(video => video.id)).size === array.length;
      if (!safeRecords(before[key]) || !safeRecords(after[key])) { delta.sections[key] = after[key]; continue; }
      const old = new Map(before[key].map(video => [video.id, video]));
      const current = new Set(after[key].map(video => video.id));
      delta.records[key] = {upserts: after[key].filter(video => old.get(video.id) !== video),
        removed: before[key].filter(video => !current.has(video.id)).map(video => video.id), order: after[key].map(video => video.id)};
    } else delta.sections[key] = after[key];
  }
  return delta;
}
function applyDelta(before, delta) {
  const data = {...before, ...delta.sections};
  for (const [key, changes] of Object.entries(delta.records || {})) {
    const records = new Map(before[key].map(video => [video.id, video]));
    changes.removed.forEach(id => records.delete(id));
    changes.upserts.forEach(video => records.set(video.id, video));
    data[key] = changes.order.map(id => records.get(id));
    if (data[key].some(video => !video)) throw failure('LIBRARY_REVISION_GAP', 'A library record is missing.');
  }
  return deepFreeze(data);
}
module.exports = {failure, deepFreeze, getAt, expectation, diffFields, encodePatch, prepareOperation, applyOperations, makeDelta, applyDelta};
