const path = require('path');
const _ = require('lodash');

function containsPath(folder, filename, platform = process.platform) {
  if (typeof folder !== 'string' || typeof filename !== 'string') return false;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => platform === 'win32' ? api.resolve(value).toLowerCase() : api.resolve(value);
  const relative = api.relative(normalize(folder), normalize(filename));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative));
}

// These are the only fields a discovered copy may change while reactivating
// a known video. User metadata, playback position and tags come from the
// current authoritative inactive record, never the scanner's old snapshot.
const SCAN_FIELDS = ['filename','duplicates'];
const SUBTITLE_FIELDS = ['subtitles','detected_subtitles','manual_subtitles','ignored_subtitles','subtitle_tracking_initialized'];

function applyScanOperation(data, operation) {
  const type = operation.opType;
  if (type === 'upsert-media') {
    const videos = operation.videos || operation.entry || [];
    if (!Array.isArray(videos)) throw new Error('Scanned videos must be an array.');
    const media = (data.media || []).slice();
    let inactive = (data.inactive_media || []).slice();
    for (const input of videos) {
      const video = input && input.video || input;
      const baseline = input && input.video && input.baseline;
      if (!video || typeof video.id !== 'string' || !video.id) throw new Error('Scanned video is missing its ID.');
      if (operation.requireWatchfolder && !(data.settings.watchfolders || []).some(folder =>
        folder && containsPath(folder.path,video.filename))) continue;
      // Another operation may already have added/reactivated this ID. Its
      // current record wins; later field patches can reconcile scan data.
      if (media.some(item => item && item.id === video.id)) continue;
      const old = inactive.find(item => item && item.id === video.id);
      if (old) {
        const next = _.cloneDeep(old);
        for (const field of SCAN_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(video,field) &&
              (!baseline || _.isEqual(old[field],baseline[field]))) next[field] = _.cloneDeep(video[field]);
        }
        // Subtitle lists and their provenance are one coherent set. If a
        // manual add/remove happened during this scan, retain that set in full
        // rather than mixing old visible paths with new tracking metadata.
        if (!baseline || SUBTITLE_FIELDS.every(field => _.isEqual(old[field],baseline[field]))) {
          for (const field of SUBTITLE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(video,field)) next[field] = _.cloneDeep(video[field]);
          }
        }
        media.push(next);
        inactive = inactive.filter(item => !item || item.id !== video.id);
      } else {
        // A reactivation whose inactive record disappeared was deliberately
        // removed in the meantime; do not resurrect the stale record.
        if (baseline) continue;
        media.push(_.cloneDeep(video));
      }
    }
    return {...data,media,inactive_media:inactive};
  }
  if (type === 'move-media') {
    const {from = 'media',to = 'inactive_media'} = operation;
    if (!['media','inactive_media'].includes(from) || (to != null && !['media','inactive_media'].includes(to))) {
      throw new Error('Invalid library media collection.');
    }
    if (from === to) return data;
    const expected = operation.expectedFilenames || {};
    const ids = new Set((operation.ids || []).filter(id => {
      const current = (data[from] || []).find(video => video && video.id === id);
      return current && (!Object.prototype.hasOwnProperty.call(expected,id) || current.filename === expected[id]);
    }));
    const moved = (data[from] || []).filter(video => video && ids.has(video.id));
    const next = {...data,[from]:(data[from] || []).filter(video => !video || !ids.has(video.id))};
    if (to != null) {
      const destination = (data[to] || []).slice();
      for (const video of moved) {
        if (!destination.some(item => item && item.id === video.id)) destination.push(video);
      }
      next[to] = destination;
    }
    return next;
  }
  if (type === 'remove-watchfolder') {
    const folder = operation.path;
    if (typeof folder !== 'string' || !folder) throw new Error('Watchfolder path is required.');
    const next = applyScanOperation(data,{opType:'move-media',from:'media',to:'inactive_media',
      ids:(data.media || []).filter(video => video && containsPath(folder,video.filename)).map(video => video.id)});
    return {...next,settings:{...next.settings,watchfolders:(next.settings.watchfolders || []).filter(item =>
      !item || !containsPath(folder,item.path) || !containsPath(item.path,folder))}};
  }
  throw new Error('Unknown scan library operation: ' + type);
}

module.exports = {applyScanOperation,containsPath};
