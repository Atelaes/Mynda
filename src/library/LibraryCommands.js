'use strict';
const _ = require('lodash');
const {getAt, diffFields} = require('./LibraryOperations');
const {trackManualSubtitleEdit} = require('../scanning/SubtitleMatcher');
const {normalizeDuplicatePaths} = require('./LibraryDuplicates');

// Shared command vocabulary; the client sends commands, the store commits them.
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
  upsertMediaBatch(videos, callback, options = {}) {
    return this.transaction([{opType: 'upsert-media', entry: videos, reactivate: options.reactivate,
      requireWatchfolder: options.requireWatchfolder}], callback, options);
  },
  moveMedia(ids, from, to, callback, options = {}) {
    return this.transaction([{opType: 'move-media', ids, from, to, expectedFilenames: options.expectedFilenames}], callback, options);
  },
  prepareRendererVideoReplacement(oldVideo, supplied) {
    let replacement = _.cloneDeep(supplied);
    const edited = replacement.__mynda_subtitles_edited === true;
    delete replacement.__mynda_subtitles_edited;
    if (oldVideo && edited) replacement = trackManualSubtitleEdit(oldVideo, replacement);
    else if (oldVideo) {
      replacement.subtitles = _.cloneDeep(oldVideo.subtitles || []);
      for (const key of ['detected_subtitles', 'manual_subtitles', 'ignored_subtitles', 'subtitle_tracking_initialized']) {
        if (Object.prototype.hasOwnProperty.call(oldVideo, key)) replacement[key] = _.cloneDeep(oldVideo[key]);
        else delete replacement[key];
      }
    }
    if (oldVideo) replacement.duplicates = normalizeDuplicatePaths(oldVideo.duplicates, oldVideo.filename);
    return replacement;
  }
};
