// Physical collection scope is identity context, not evidence of episode
// order. Only cross a recognized season folder whose parent names the whole
// series. Unknown subfolders, editions and franchise branches remain separate.
const {seriesIdentityKey} = require('./TitleNormalization');
const {seriesSearchPartsForVideo,extractSeriesSearchParts,extractSeriesFolderYear} = require('./SeriesIdentity');
const {repeatedSeriesPrefix,technicalOnly} = require('./EpisodeTitleEvidence');

function seasonFolder(name, series) {
  const prefix = repeatedSeriesPrefix(name,series);
  const text = prefix ? prefix.title : name;
  const match = /^(?:season[\s._-]*|s)(\d{1,3})(?!\d)(.*)$/i.exec(text);
  if (!match) return false;
  // Preserve balanced source brackets for the shared release interpreter.
  const suffix = match[2].replace(/^[\s._–—-]+|[\s._–—-]+$/g,'');
  return !suffix || technicalOnly(suffix);
}

function collectionFolder(name, series) {
  const expected = seriesIdentityKey(series);
  const parts = extractSeriesSearchParts(name);
  if (seriesIdentityKey(parts.title) === expected) return true;
  const prefix = repeatedSeriesPrefix(parts.title,series);
  if (!prefix) return false;
  // Structural collection labels only. Do not strip arbitrary subtitle,
  // region, edition or remake words as the discovery query builder may do.
  return /^(?:(?:complete(?:[ ._-]+original)?(?:[ ._-]+tv)?[ ._-]+series)|(?:complete[ ._-]+)?seasons?[ ._-]*\d{1,3}[ ._-]*[-–—][ ._-]*\d{1,3})(?:\s*[([]s\d{1,3}\s*[-–—]\s*s?\d{1,3}[)\]])?$/i.test(prefix.title);
}

function scopeFor(video) {
  if (!video || video.kind !== 'show' || video.dvd || !video.series || !video.filename) return null;
  const parts = String(video.filename).replace(/\\/g,'/').split('/');
  if (parts.length < 2 || parts.some(part => part === '.' || part === '..')) return null;
  const series = seriesSearchPartsForVideo(video);
  const name = seriesIdentityKey(series.title);
  if (!name) return null;
  const folders = parts.slice(0,-1);
  const directory = folders.join('/');
  let root = directory;
  if (folders.length > 1 && seasonFolder(folders[folders.length-1],series.title) &&
      collectionFolder(folders[folders.length-2],series.title)) root = folders.slice(0,-1).join('/');
  return {key:JSON.stringify([name,root]),directoryKey:JSON.stringify([name,directory]),
    root,directory,series:series.title,year:series.year || null,
    years:[...new Set([series.year,extractSeriesFolderYear(video.filename,series.title)].filter(Boolean))]};
}

module.exports = {scopeFor};
