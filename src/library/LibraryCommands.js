'use strict';
const _ = require('lodash');
const {trackManualSubtitleEdit} = require('../scanning/SubtitleMatcher');
const {normalizeDuplicatePaths} = require('./LibraryDuplicates');
const clientCommands = require('./LibraryClientCommands');

module.exports = {
  ...clientCommands,
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
