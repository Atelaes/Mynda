const MediaTools = require('./MediaTools.js');
const {durationFromProbe} = require('./MediaMetadata.js');
const {parseRuntimeMinutes} = require('./MovieSearch.js');
const log = require('./Logger.js').child('OMDb');

// Technical duration may be read from the media, but no title/series information
// is read here. Failed probes remain optional evidence and receive a short cache
// lifetime; they must not turn every otherwise sound match into a failure.
function createDurationReader(options = {}) {
  const probe = options.probe || MediaTools.probeFile;
  const now = options.now || Date.now;
  const cache = new Map();
  return async function withEpisodeDuration(video, episodeData, context = {}) {
    const seconds = Number(video && video.metadata && video.metadata.duration);
    if ((Number.isFinite(seconds) && seconds > 0) || !video || video.dvd ||
        !video.filename || !parseRuntimeMinutes(episodeData && episodeData.Runtime)) return video;
    const key = JSON.stringify([video.id || '', video.filename]);
    let entry = cache.get(key);
    if (!entry || entry.expires <= now()) {
      entry = {expires: Infinity};
      entry.promise = Promise.resolve().then(() => probe(video.filename, {timeout: 7000}))
        .then(data => durationFromProbe(data))
        .catch(error => {
          log.debug('Episode runtime unavailable; continuing with other matching evidence', {
            searchID: context.searchID, videoID: video.id, error
          });
          return 0;
        }).then(duration => {
          if (!duration) entry.expires = now() + 60000;
          return duration;
        });
      if (cache.size >= 2048) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
    }
    const duration = await entry.promise;
    return duration > 0 ? {...video, metadata: {...video.metadata, duration}} : video;
  };
}

module.exports = {createDurationReader, withEpisodeDuration: createDurationReader()};
