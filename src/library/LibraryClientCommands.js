'use strict';
const {diffFields} = require('./LibraryProtocol');

// User-edit command vocabulary shared by the renderer client and main store.
// Scan mutations and subtitle/path normalization remain backend-only.
module.exports = {
  add(address, entry, callback) { return this.transaction([{opType: 'add', address, entry}], callback); },
  replace(address, entry, callback) { return this.transaction([{opType: 'replace', address, entry}], callback); },
  remove(address, callback) { return this.transaction([{opType: 'remove', address}], callback); },
  patchMedia(id, changes, expected, callback, options) {
    return this.patchMediaBatch([{id, changes, expected}], callback, options);
  },
  patchMediaBatch(patches, callback, options = {}) {
    return this.transaction([{opType: 'patch-media', patches}], callback, options);
  },
  replaceMediaBatch(videos, callback, options = {}) {
    const patches = videos.map(video => {
      const baseline = this.media.find(current => current && current.id === video.id);
      return {id: video.id, baseline, changes: diffFields(baseline || {}, video)};
    });
    return this.patchMediaBatch(patches, callback, options);
  },
  patchWatchfolder(path, changes, expected, callback) {
    return this.transaction([{opType: 'patch-watchfolder', path, changes, expected}], callback);
  },
  recordPlayed(id, callback) { return this.transaction([{opType: 'record-played', id}], callback); },
};
