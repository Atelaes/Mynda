'use strict';
const CatalogIdentity = require('../tagging/CatalogIdentity');

// Main-process input validation for the renderer's public edit commands. File
// references are capabilities: a draft may retain an existing reference, but
// introducing another file requires authorization from the native chooser or
// the editor's managed-artwork service.
const _ = require('lodash');
const {failure, parts, getAt, diffFields} = require('./LibraryProtocol');

const SCANNER_FIELDS = new Set(['id', 'filename', 'duplicates', 'metadata', 'dvd',
  'detected_subtitles', 'manual_subtitles', 'ignored_subtitles', 'subtitle_tracking_initialized']);
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_NODES = 1000000;
const MAX_TEXT = 64 * 1024 * 1024;

function invalid(message) { throw failure('INVALID_LIBRARY_OPERATION', message); }
function object(value, name) {
  if (!_.isPlainObject(value)) invalid(`Invalid ${name}.`);
}
function text(value, name, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) invalid(`Invalid ${name}.`);
}
function address(value) {
  text(value, 'library field address');
  const keys = parts(value);
  if (keys.length > 16) invalid('The library field address is too deep.');
  return keys;
}
function boundedPayload(value) {
  let count = 0, length = 0;
  const active = new Set();
  function visit(item, depth) {
    if (++count > MAX_NODES || depth > 32) invalid('The library edit is too large or too deeply nested.');
    if (typeof item === 'string') {
      length += item.length;
      if (item.length > 1024 * 1024 || length > MAX_TEXT) invalid('The library edit contains too much text.');
      return;
    }
    if (item === null || item === undefined || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && !_.isPlainObject(item))) invalid('Library edits must contain plain data.');
    if (active.has(item)) invalid('Library edits cannot contain circular data.');
    active.add(item);
    for (const key of Object.keys(item)) {
      if (FORBIDDEN.has(key)) invalid('Unsafe library record property.');
      if (key.length > 512) invalid('Invalid library record property.');
      visit(item[key], depth + 1);
    }
    active.delete(item);
  }
  visit(value, 0);
}
function expectation(value) {
  if (value === undefined) return;
  object(value, 'library field expectation');
  if (typeof value.present !== 'boolean') invalid('Invalid library field expectation.');
}
function fields(value, name) {
  if (!Array.isArray(value) || value.length > 10000) invalid(`Invalid ${name}.`);
  for (const field of value) {
    object(field, 'library field');
    address(field.path);
    if (field.remove !== undefined && typeof field.remove !== 'boolean') invalid('Invalid library field removal.');
    expectation(field.expected);
  }
}
function validateRendererCommit(request, {library, authorizeSubtitle = () => false,
  authorizeArtwork = () => false} = {}) {
  boundedPayload(request);
  object(request, 'library request');
  text(request.requestId, 'request identifier', 200);
  if (!Array.isArray(request.operations) || !request.operations.length || request.operations.length > 10000) {
    invalid('A nonempty, bounded operation list is required.');
  }
  const data = library && (typeof library.getSaveObject === 'function' ? library.getSaveObject() : library);
  if (!data || !Array.isArray(data.media)) invalid('The library is unavailable.');
  const videos = new Map(data.media.filter(Boolean).map(video => [video.id, video]));
  function findVideo(id) {
    text(id, 'video ID', 256);
    const video = videos.get(id);
    if (!video) throw failure('LIBRARY_CONFLICT', 'The video is no longer in the active library.', {id});
    return video;
  }
  function mediaFields(video, entries) {
    fields(entries, 'video field list');
    for (const field of entries) {
      const keys = address(field.path), root = keys[0];
      if (SCANNER_FIELDS.has(root)) invalid('This field is maintained by the library scanner.');
      if (['catalogRef','catalogSeriesRef'].includes(root)) {
        if(keys.length!==1 || (!field.remove && field.value!==null && !CatalogIdentity.native(field.value)))invalid('Invalid catalog reference.');
      }
      if (root === 'subtitles') {
        if (keys.length !== 1) invalid('Subtitle edits must replace the visible subtitle list.');
        if (field.remove) continue;
        if (!Array.isArray(field.value) || field.value.length > 2000) invalid('Invalid subtitle list.');
        for (const subtitle of field.value) {
          text(subtitle, 'subtitle path', 4096);
          if (!(video.subtitles || []).includes(subtitle) && authorizeSubtitle(subtitle, video) !== true) {
            invalid('Choose a subtitle file in the editor before adding it to the library.');
          }
        }
      }
      if (root === 'artwork') {
        if (keys.length !== 1) invalid('Artwork edits must replace the artwork reference.');
        if (field.remove || field.value === '') continue;
        text(field.value, 'artwork path', 4096);
        if (field.value !== video.artwork && authorizeArtwork(field.value, video) !== true) {
          invalid('Choose or download artwork in the editor before adding it to the library.');
        }
      }
    }
  }
  for (const operation of request.operations) {
    object(operation, 'library operation');
    if (operation.opType === 'patch-media') {
      if (!Array.isArray(operation.patches) || operation.patches.length > 10000) invalid('Invalid video patch list.');
      for (const patch of operation.patches) {
        object(patch, 'video patch');
        mediaFields(findVideo(patch.id), patch.fields);
        if (patch.guards !== undefined) fields(patch.guards, 'video guard list');
        if (patch.baseline !== undefined) object(patch.baseline, 'video baseline');
      }
      continue;
    }
    if (operation.opType === 'record-played') { findVideo(operation.id); continue; }
    if (operation.opType === 'patch-watchfolder') {
      text(operation.path, 'watchfolder path', 4096);
      fields(operation.fields, 'watchfolder field list');
      for (const field of operation.fields) {
        if (field.path !== 'kind' || field.remove) invalid('Only the watchfolder kind can be edited here.');
        text(field.value, 'watchfolder kind', 256);
      }
      continue;
    }
    if (!['add', 'replace', 'remove'].includes(operation.opType)) invalid('This operation belongs to the backend.');
    const keys = address(operation.address);
    expectation(operation.check);
    if (keys[0] === 'media') {
      if (operation.opType !== 'replace' || keys.length < 2) invalid('Video changes must use field patches.');
      const video = getAt(data, keys.slice(0, 2));
      if (!video) throw failure('LIBRARY_CONFLICT', 'The video is no longer in the active library.');
      const changes = keys.length === 2 ? diffFields(video, operation.entry) : {[keys.slice(2).join('.')]: operation.entry};
      mediaFields(video, Object.entries(changes).map(([path, value]) => ({path, value, remove: value === undefined})));
    } else if (keys[0] === 'settings') {
      // No whole-settings replacement: it could smuggle in new filesystem
      // roots even when the direct watchfolder address is blocked.
      if (!['preferences', 'used', 'themes'].includes(keys[1])) invalid('Watchfolders must be changed through their native controls.');
    } else if (!['playlists', 'recently_watched'].includes(keys[0])) invalid('This library section cannot be changed.');
  }
}

module.exports = {validateRendererCommit, boundedPayload};
