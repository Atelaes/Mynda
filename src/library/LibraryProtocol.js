'use strict';

// Browser-safe transaction protocol: prepare detached edits and apply published
// deltas. Only LibraryOperations in the main process may authorize and mutate
// library records; this module has no filesystem or Electron dependencies.
const _ = require('lodash');
const ROOTS = new Set(['media', 'inactive_media', 'settings', 'playlists', 'recently_watched']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

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
    // Provider and ID are one identity and must be compared/replaced atomically.
    if (!['catalogRef','catalogSeriesRef'].includes(address) && _.isPlainObject(left) && _.isPlainObject(right)) diffFields(left, right, address, changes);
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
module.exports = {ROOTS, FORBIDDEN, failure, deepFreeze, parts, getAt, setAt,
  expectation, diffFields, encodePatch, prepareOperation, assertExpected,
  makeDelta, applyDelta};
