const path = require('path');

// Formats understood by MPV that are reasonably unambiguous as subtitle
// files. Text files are deliberately excluded because watchfolders commonly
// contain release notes and torrent-site advertisements.
const subtitleExtensions = [
  'srt', 'ass', 'ssa', 'vtt', 'usf', 'ttml', 'dfxp', 'sub', 'idx', 'smi',
  'sami', 'mpl2', 'sup', 'mks', 'scc', 'sbv'
];

const genericSubtitleFolders = new Set([
  'sub', 'subs', 'subtitle', 'subtitles', 'caption', 'captions', 'vobsub',
  'english', 'eng', 'en', 'forced', 'sdh', 'cc'
]);
const genericSubtitleFolderTokens = new Set([
  'file', 'files', 'folder', 'folders', 'microdvd', 'pgs', 'srt', 'vobsub'
]);

const languageTokens = new Set([
  'ara', 'arabic', 'baq', 'basque', 'ben', 'bengali', 'bos', 'bosnian',
  'bul', 'bulgarian', 'cat', 'catalan', 'chi', 'chinese', 'cze', 'czech',
  'dan', 'danish', 'dut', 'dutch', 'ell', 'eng', 'english', 'est', 'estonian',
  'farsi', 'fin', 'finnish', 'fre', 'french', 'ger', 'german', 'gre', 'greek',
  'heb', 'hebrew', 'hin', 'hindi', 'hrv', 'croatian', 'hun', 'hungarian',
  'ice', 'icelandic', 'ind', 'indonesian', 'ita', 'italian', 'jpn', 'japanese',
  'kor', 'korean', 'lav', 'latvian', 'lit', 'lithuanian', 'may', 'malay',
  'nor', 'norwegian', 'per', 'persian', 'pol', 'polish', 'por', 'portuguese',
  'rum', 'romanian', 'rus', 'russian', 'slk', 'slovak', 'slv', 'slovenian',
  'spa', 'spanish', 'srp', 'serbian', 'swe', 'swedish', 'tha', 'thai',
  'tur', 'turkish', 'ukr', 'ukrainian', 'vie', 'vietnamese'
]);

const subtitleQualifierTokens = new Set([
  ...languageTokens, 'cc', 'closed', 'commentary', 'director', 'directors',
  'forced', 'foreign', 'full', 'hearing', 'hi', 'non', 'only', 'sdh',
  'signs', 'songs', 'sub', 'subs', 'subtitle', 'subtitles'
]);

const releaseTokens = new Set([
  '360p', '480p', '576p', '720p', '1080p', '1440p', '2160p', '4320p',
  'bluray', 'bdrip', 'brrip', 'dvdrip', 'hdtv', 'hdrip', 'uhd', 'web',
  'webdl', 'webrip', 'remux', 'xvid', 'divx', 'x264', 'x265', 'h264',
  'h265', 'hevc', 'avc', 'aac', 'ac3', 'eac3', 'ddp', 'dts', 'truehd',
  'atmos', 'yify', 'yts', 'rarbg', 'etrg', 'proper', 'repack', '10bit'
]);

function pathKey(value) {
  let normalized = path.normalize(String(value));
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function uniquePaths(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value === '') continue;
    const key = pathKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathSetsEqual(left, right) {
  const leftKeys = new Set(uniquePaths(left).map(pathKey));
  const rightKeys = new Set(uniquePaths(right).map(pathKey));
  if (leftKeys.size !== rightKeys.size) return false;
  return [...leftKeys].every(key => rightKeys.has(key));
}

function rawTokens(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizedName(value) {
  return rawTokens(value).join(' ');
}

function trimSubtitleQualifiers(tokens) {
  const result = tokens.slice();
  while (result.length > 0 && subtitleQualifierTokens.has(result[result.length-1])) {
    result.pop();
  }
  return result;
}

function coreTokens(value) {
  let tokens = trimSubtitleQualifiers(rawTokens(value));
  const stop = tokens.findIndex(token =>
    releaseTokens.has(token) || /^\d{3,4}p$/.test(token) ||
    /^(?:x|h)26[45]$/.test(token) || /^\d{3,4}x\d{3,4}$/.test(token)
  );
  if (stop >= 0) tokens = tokens.slice(0, stop);
  return tokens;
}

function isPrefix(shorter, longer) {
  return shorter.length > 0 && shorter.length <= longer.length &&
    shorter.every((value, index) => value === longer[index]);
}

function tokenSimilarity(leftTokens, rightTokens) {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  const intersection = [...left].filter(token => right.has(token)).length;
  return intersection / Math.max(left.size, right.size, 1);
}

function yearIn(value) {
  return rawTokens(value).find(token => /^(?:19|20)\d{2}$/.test(token)) || null;
}

function seasonNumber(value) {
  const match = String(value).match(/(?:^|[^a-z0-9])(?:season|series|s)[. _-]*(\d{1,3})(?!\d)/i);
  return match ? Number(match[1]) : null;
}

function explicitEpisodeKey(value) {
  const name = String(value);
  const match = name.match(/(?:^|[^a-z0-9])s(\d{1,3})[. _-]*e[. _-]*(\d{1,3})(?!\d)/i) ||
    name.match(/season[. _-]*(\d{1,3})[. _-]*(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i) ||
    name.match(/(?:^|[^\d])(\d{1,2})[ _-]*x[ _-]*(\d{1,3})(?!\d)/i) ||
    name.match(/^\s*(\d{1,2})\.(\d{1,3})(?![.\d])/);
  return match ? `${Number(match[1])}:${Number(match[2])}` : null;
}

function episodeOnlyNumber(value) {
  const name = String(value);
  const match = name.match(/(?:^|[^a-z0-9])(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i) ||
    name.match(/^\s*(\d{1,3})\s*$/);
  return match ? Number(match[1]) : null;
}

function episodeKey(item) {
  const explicit = explicitEpisodeKey(item.basename);
  if (explicit) return explicit;

  const episode = episodeOnlyNumber(item.basename);
  if (episode === null) return null;

  let directory = item.directory;
  while (directory !== '') {
    const season = seasonNumber(path.basename(directory));
    if (season !== null) return `${season}:${episode}`;
    const parent = path.dirname(directory);
    directory = parent === '.' ? '' : parent;
  }
  return null;
}

function isGenericSubtitleFolder(value) {
  const name = normalizedName(value);
  if (genericSubtitleFolders.has(name)) return true;
  const tokens = rawTokens(value);
  return tokens.length > 0 && tokens.every(token =>
    genericSubtitleFolders.has(token) || subtitleQualifierTokens.has(token) ||
    genericSubtitleFolderTokens.has(token)
  );
}

function ancestorDirectories(directory, boundary) {
  const result = [];
  let current = directory;
  while (true) {
    result.push(current);
    if (current === boundary || current === '') break;
    const parent = path.dirname(current);
    current = parent === '.' ? '' : parent;
  }
  return result;
}

function isWithin(value, directory) {
  return directory === '' || value === directory || value.startsWith(`${directory}${path.sep}`);
}

function directVideos(videos, directory) {
  return videos.filter(video => video.directory === directory);
}

function videoBasename(video) {
  const name = path.basename(video.filename);
  if (video.dvd) return name.replace(/\.dvdmedia$/i, '');
  return path.basename(name, path.extname(name));
}

function subtitleBasename(filename) {
  const name = path.basename(filename);
  return path.basename(name, path.extname(name));
}

function firstPathComponent(relativePath) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

function flattenWatchfolder(rootNode) {
  const videos = [];
  const subtitles = [];
  const rootPath = rootNode.path;

  function visit(node) {
    for (const video of node.videos || []) {
      const relativePath = path.relative(rootPath, video.filename);
      const relativeDirectoryValue = path.dirname(relativePath);
      const relativeDirectory = relativeDirectoryValue === '.' ? '' : relativeDirectoryValue;
      videos.push({
        video,
        filename: video.filename,
        basename: videoBasename(video),
        relativePath,
        directory: relativeDirectory,
        scope: firstPathComponent(relativePath)
      });
    }
    for (const filename of node.subtitles || []) {
      const relativePath = path.relative(rootPath, filename);
      const relativeDirectoryValue = path.dirname(relativePath);
      const relativeDirectory = relativeDirectoryValue === '.' ? '' : relativeDirectoryValue;
      subtitles.push({
        filename,
        basename: subtitleBasename(filename),
        relativePath,
        directory: relativeDirectory,
        scope: firstPathComponent(relativePath)
      });
    }
    for (const child of node.folders || []) visit(child);
  }

  visit(rootNode);
  return {videos, subtitles};
}

function scoreNameMatch(subtitle, video) {
  const subtitleTokens = trimSubtitleQualifiers(rawTokens(subtitle.basename));
  const videoTokens = rawTokens(video.basename);
  const subtitleCore = coreTokens(subtitle.basename);
  const videoCore = coreTokens(video.basename);
  let score = 0;

  if (arraysEqual(subtitleTokens, videoTokens)) score = Math.max(score, 100);

  const shorter = subtitleTokens.length <= videoTokens.length ? subtitleTokens : videoTokens;
  const longer = subtitleTokens.length <= videoTokens.length ? videoTokens : subtitleTokens;
  // A one-word prefix is too weak: it was the source of associations such as
  // M.dvdmedia receiving every subtitle whose filename began with M.
  if (shorter.length >= 2 && isPrefix(shorter, longer)) score = Math.max(score, 92);

  const oneWordTitleWithOnlyYears = shorter.length === 1 && longer[0] === shorter[0] &&
    longer.slice(1).length > 0 &&
    longer.slice(1).every(token => /^(?:19|20)\d{2}$/.test(token));
  if (oneWordTitleWithOnlyYears) score = Math.max(score, 95);

  const subtitleEpisode = episodeKey(subtitle);
  const videoEpisode = episodeKey(video);
  if (subtitleEpisode && videoEpisode && subtitleEpisode === videoEpisode) {
    score = Math.max(score, 88);
  }

  const subtitleYear = yearIn(subtitle.basename);
  const videoYear = yearIn(video.basename);
  const compatibleYears = !subtitleYear || !videoYear || subtitleYear === videoYear;
  const similarity = tokenSimilarity(subtitleCore, videoCore);
  const minimumCoreLength = Math.min(new Set(subtitleCore).size, new Set(videoCore).size);
  if (compatibleYears && minimumCoreLength >= 2 && similarity >= 0.75) {
    score = Math.max(score, 80 + Math.round(similarity * 10));
  }

  for (const directory of ancestorDirectories(subtitle.directory, subtitle.scope)) {
    if (!directory) continue;
    const folderCore = coreTokens(path.basename(directory));
    const folderSimilarity = tokenSimilarity(folderCore, videoCore);
    if (arraysEqual(folderCore, videoCore)) score = Math.max(score, 98);
    else if (Math.min(folderCore.length, videoCore.length) >= 2 && folderSimilarity >= 0.8) {
      score = Math.max(score, 90);
    }
  }

  return score;
}

function bestNameMatches(subtitle, videos) {
  const scored = videos
    .map(video => ({video, score: scoreNameMatch(subtitle, video)}))
    .filter(item => item.score >= 80)
    .sort((left, right) => right.score-left.score);
  if (scored.length === 0) return {matches: [], ambiguous: []};

  const bestScore = scored[0].score;
  const best = scored.filter(item => item.score === bestScore);
  const subtitleEpisode = episodeKey(subtitle);
  const sameEpisode = subtitleEpisode
    ? best.filter(item => episodeKey(item.video) === subtitleEpisode)
    : [];

  // Multiple editions of the same explicitly numbered episode can all use
  // the same external subtitle. Exact release/folder-name ties are likewise
  // safe; weaker ties are left unresolved.
  if (sameEpisode.length > 1 && sameEpisode.length === best.length) {
    return {matches: sameEpisode.map(item => item.video), ambiguous: []};
  }
  if (best.length === 1 || bestScore >= 98) {
    return {matches: best.map(item => item.video), ambiguous: []};
  }
  return {matches: [], ambiguous: best};
}

function matchWatchfolderSubtitles(rootNode) {
  const flattened = flattenWatchfolder(rootNode);
  const results = new Map(flattened.videos.map(video => [video.video, []]));
  const unmatched = [];
  const ambiguous = [];
  const scopes = new Map();

  for (const video of flattened.videos) {
    if (!scopes.has(video.scope)) scopes.set(video.scope, {videos: [], subtitles: []});
    scopes.get(video.scope).videos.push(video);
  }
  for (const subtitle of flattened.subtitles) {
    if (!scopes.has(subtitle.scope)) scopes.set(subtitle.scope, {videos: [], subtitles: []});
    scopes.get(subtitle.scope).subtitles.push(subtitle);
  }

  for (const scope of scopes.values()) {
    for (const subtitle of scope.subtitles) {
      let matches = [];

      // The deepest ancestor containing exactly one video is strong evidence:
      // this covers ordinary movie folders and release-specific Subs folders.
      for (const directory of ancestorDirectories(subtitle.directory, subtitle.scope)) {
        const contained = scope.videos.filter(video => isWithin(video.relativePath, directory));
        if (contained.length === 1) {
          matches = contained;
          break;
        }
      }

      // A subtitle beside the sole direct video belongs to that video even if
      // the folder also contains unrelated videos in child folders.
      if (matches.length === 0) {
        const direct = directVideos(scope.videos, subtitle.directory);
        if (direct.length === 1) matches = direct;
      }

      // A conventional Subs/Subtitles descendant can belong to the sole video
      // directly in its nearest non-subtitle ancestor.
      if (matches.length === 0) {
        for (const directory of ancestorDirectories(subtitle.directory, subtitle.scope)) {
          const relative = path.relative(directory, subtitle.directory);
          const parts = relative ? relative.split(path.sep) : [];
          if (parts.length > 0 && parts.every(isGenericSubtitleFolder)) {
            const direct = directVideos(scope.videos, directory);
            if (direct.length === 1) {
              matches = direct;
              break;
            }
          }
        }
      }

      if (matches.length === 0) {
        const named = bestNameMatches(subtitle, scope.videos);
        matches = named.matches;
        if (named.ambiguous.length > 0) ambiguous.push({subtitle, scored: named.ambiguous});
      }

      // If the watchfolder itself is one movie/show folder, a top-level
      // Subs/Subtitles directory will otherwise be in a different scope from
      // its videos. Cross that boundary only for a sole video or strong name /
      // season-episode evidence; never search arbitrary sibling movie folders.
      if (matches.length === 0 && isGenericSubtitleFolder(subtitle.scope)) {
        if (flattened.videos.length === 1) {
          matches = flattened.videos;
        } else {
          const named = bestNameMatches(subtitle, flattened.videos);
          matches = named.matches;
          if (named.ambiguous.length > 0) ambiguous.push({subtitle, scored: named.ambiguous});
        }
      }

      if (matches.length === 0) {
        unmatched.push(subtitle.filename);
      } else {
        for (const video of matches) results.get(video.video).push(subtitle.filename);
      }
    }
  }

  return {results, unmatched, ambiguous, numSubtitles: flattened.subtitles.length};
}

function prepareSubtitleMatches(libFileTree, unavailableWatchFolders) {
  const detectedOwners = new Map();
  const stats = {
    numSubtitles: 0,
    matchedSubtitles: new Set(),
    unmatched: [],
    ambiguous: [],
    multiplyAssignedSubtitles: new Set()
  };

  for (const rootNode of (libFileTree && libFileTree.folders) || []) {
    if (unavailableWatchFolders && unavailableWatchFolders.has(rootNode.path)) continue;
    const matched = matchWatchfolderSubtitles(rootNode);
    stats.numSubtitles += matched.numSubtitles;
    stats.unmatched.push(...matched.unmatched);
    stats.ambiguous.push(...matched.ambiguous);

    for (const [video, subtitles] of matched.results) {
      video.subtitles = uniquePaths(subtitles);
      for (const subtitle of video.subtitles) {
        const subtitleKey = pathKey(subtitle);
        if (!detectedOwners.has(subtitleKey)) detectedOwners.set(subtitleKey, new Set());
        const owners = detectedOwners.get(subtitleKey);
        owners.add(pathKey(video.filename));
        stats.matchedSubtitles.add(subtitleKey);
        if (owners.size > 1) stats.multiplyAssignedSubtitles.add(subtitleKey);
      }
    }
  }

  return {detectedOwners, stats};
}

function buildLegacySubtitleCounts(media, inactiveMedia) {
  const counts = new Map();
  for (const video of [...(media || []), ...(inactiveMedia || [])]) {
    if (!video || typeof video !== 'object') continue;
    const videoPaths = new Set(uniquePaths(video.subtitles).map(pathKey));
    for (const subtitleKey of videoPaths) {
      counts.set(subtitleKey, (counts.get(subtitleKey) || 0) + 1);
    }
  }
  return counts;
}

function effectiveSubtitleList(previousVisible, manual, detected, ignored) {
  const manualKeys = new Set(manual.map(pathKey));
  const ignoredKeys = new Set(ignored.map(pathKey));
  const availableDetected = detected.filter(value =>
    !ignoredKeys.has(pathKey(value)) || manualKeys.has(pathKey(value))
  );
  const allowedKeys = new Set([...manual, ...availableDetected].map(pathKey));
  return uniquePaths([
    ...uniquePaths(previousVisible).filter(value => allowedKeys.has(pathKey(value))),
    ...manual,
    ...availableDetected
  ]);
}

function legacyAssociationLooksPlausible(video, subtitle) {
  const subtitleCore = coreTokens(subtitleBasename(subtitle));
  const videoCore = coreTokens(videoBasename(video));
  const shorter = subtitleCore.length <= videoCore.length ? subtitleCore : videoCore;
  const longer = subtitleCore.length <= videoCore.length ? videoCore : subtitleCore;
  if (arraysEqual(subtitleCore, videoCore)) return true;
  if (videoCore.length === 1 && subtitleCore[0] === videoCore[0] &&
      subtitleCore.slice(1).every(token => /^(?:19|20)\d{2}$/.test(token))) return true;
  if (shorter.length >= 2 && isPrefix(shorter, longer)) return true;
  const subtitleYear = yearIn(subtitleBasename(subtitle));
  const videoYear = yearIn(videoBasename(video));
  if (subtitleYear && videoYear && subtitleYear !== videoYear) return false;
  return Math.min(subtitleCore.length, videoCore.length) >= 2 &&
    tokenSimilarity(subtitleCore, videoCore) >= 0.75;
}

function legacyAssociationLooksLikeSameWork(video, subtitle) {
  const subtitleName = subtitleBasename(subtitle);
  const videoName = videoBasename(video);
  const subtitleEpisode = explicitEpisodeKey(subtitleName);
  const videoEpisode = explicitEpisodeKey(videoName);
  if (subtitleEpisode && videoEpisode && subtitleEpisode === videoEpisode) return true;

  const subtitleYear = yearIn(subtitleName);
  const videoYear = yearIn(videoName);
  if (subtitleYear && videoYear && subtitleYear !== videoYear) return false;
  const withoutYears = tokens => tokens.filter(token => !/^(?:19|20)\d{2}$/.test(token));
  const subtitleTitle = withoutYears(coreTokens(subtitleName));
  const videoTitle = withoutYears(coreTokens(videoName));
  return subtitleTitle.length > 0 && arraysEqual(subtitleTitle, videoTitle);
}

function reconcileVideoSubtitles(video, detectedSubtitles, context) {
  const oldVisible = uniquePaths(video.subtitles);
  const detected = uniquePaths(detectedSubtitles);
  let manual;
  let ignored;

  if (video.subtitle_tracking_initialized === true) {
    const previousDetectedKeys = new Set(uniquePaths(video.detected_subtitles).map(pathKey));
    manual = Array.isArray(video.manual_subtitles)
      ? uniquePaths(video.manual_subtitles)
      : oldVisible.filter(value => !previousDetectedKeys.has(pathKey(value)));
    ignored = uniquePaths(video.ignored_subtitles);
  } else {
    // A legacy library has no provenance. Keep unique/unclaimed associations
    // as manual, but remove repeated associations that the new matcher assigns
    // to another video. This cleans known prefix-regex corruption without
    // risking the loss of a unique manually attached subtitle.
    const detectedKeys = new Set(detected.map(pathKey));
    const knownManualKeys = new Set(uniquePaths(video.manual_subtitles).map(pathKey));
    const detectedOwners = context && context.detectedOwners;
    const legacyCounts = context && context.legacyCounts;
    const videoKey = pathKey(video.filename);
    manual = uniquePaths(video.manual_subtitles);
    ignored = uniquePaths(video.ignored_subtitles);

    const unclassified = [];
    let suspiciousRepeatedAssociations = 0;
    let suspiciousPrefixAssociations = 0;
    const legacyVideoPrefix = normalizedName(videoBasename(video));
    for (const subtitle of oldVisible) {
      const subtitleKey = pathKey(subtitle);
      if (detectedKeys.has(subtitleKey) || knownManualKeys.has(subtitleKey)) continue;
      const owners = detectedOwners && detectedOwners.get(subtitleKey);
      const claimedByAnotherVideo = owners && owners.size > 0 && !owners.has(videoKey);
      const repeatedLegacyAssociation = legacyCounts && (legacyCounts.get(subtitleKey) || 0) > 1;
      const plausibleAssociation = legacyAssociationLooksPlausible(video, subtitle);
      const sameWorkAssociation = legacyAssociationLooksLikeSameWork(video, subtitle);
      if (repeatedLegacyAssociation && !plausibleAssociation) {
        suspiciousRepeatedAssociations++;
      }
      if (!plausibleAssociation && legacyVideoPrefix !== '' &&
          normalizedName(subtitleBasename(subtitle)).startsWith(legacyVideoPrefix)) {
        suspiciousPrefixAssociations++;
      }
      // This exact path is duplicated in the old library and is now
      // confidently matched to a different video.
      const strongFalsePositive = claimedByAnotherVideo &&
        repeatedLegacyAssociation && !sameWorkAssociation;
      if (!strongFalsePositive) {
        unclassified.push({subtitle, plausibleAssociation});
      }
    }

    // Catastrophic old matches have a distinctive signature: most of a
    // video's list is either duplicated across the library or begins with a
    // short basename that the old unescaped prefix regex matched too freely.
    // In that case, discard the few remaining unrelated paths too. Names that
    // plausibly match this video are still preserved as manual.
    const repeatedCorruptionSignature = suspiciousRepeatedAssociations >= 5 &&
      suspiciousRepeatedAssociations / Math.max(oldVisible.length, 1) >= 0.5;
    const minimumPrefixEvidence = legacyVideoPrefix.replace(/\s/g, '').length <= 3 ? 2 : 5;
    const prefixCorruptionSignature = suspiciousPrefixAssociations >= minimumPrefixEvidence &&
      suspiciousPrefixAssociations / Math.max(oldVisible.length, 1) >= 0.5;
    const corruptionSignature = repeatedCorruptionSignature || prefixCorruptionSignature;
    for (const item of unclassified) {
      const likelyResidualFalsePositive = corruptionSignature &&
        !item.plausibleAssociation;
      if (!likelyResidualFalsePositive) manual.push(item.subtitle);
    }
    manual = uniquePaths(manual);
  }

  const manualKeys = new Set(manual.map(pathKey));
  ignored = ignored.filter(value => !manualKeys.has(pathKey(value)));
  const visible = effectiveSubtitleList(oldVisible, manual, detected, ignored);

  video.subtitles = visible;
  video.detected_subtitles = detected;
  video.manual_subtitles = manual;
  video.ignored_subtitles = ignored;
  video.subtitle_tracking_initialized = true;
  return !arraysEqual(oldVisible, visible);
}

function trackManualSubtitleEdit(oldVideo, newVideo) {
  if (!oldVideo || !newVideo || !Array.isArray(newVideo.subtitles)) return newVideo;

  const oldVisible = uniquePaths(oldVideo.subtitles);
  const newVisible = uniquePaths(newVideo.subtitles);
  if (pathSetsEqual(oldVisible, newVisible)) {
    newVideo.subtitles = newVisible;
    // A renderer may save a stale clone that predates the last backend scan.
    // Carry the authoritative hidden tracking fields forward even when the
    // visible subtitle list itself was not edited.
    if (oldVideo.subtitle_tracking_initialized === true) {
      const detected = uniquePaths(oldVideo.detected_subtitles);
      const detectedKeys = new Set(detected.map(pathKey));
      newVideo.detected_subtitles = detected;
      newVideo.manual_subtitles = Array.isArray(oldVideo.manual_subtitles)
        ? uniquePaths(oldVideo.manual_subtitles)
        : oldVisible.filter(value => !detectedKeys.has(pathKey(value)));
      newVideo.ignored_subtitles = uniquePaths(oldVideo.ignored_subtitles);
      newVideo.subtitle_tracking_initialized = true;
    }
    return newVideo;
  }

  let detected;
  let manual;
  let ignored;
  const initialized = oldVideo.subtitle_tracking_initialized === true;

  if (initialized) {
    detected = uniquePaths(oldVideo.detected_subtitles);
    const detectedKeys = new Set(detected.map(pathKey));
    manual = Array.isArray(oldVideo.manual_subtitles)
      ? uniquePaths(oldVideo.manual_subtitles)
      : oldVisible.filter(value => !detectedKeys.has(pathKey(value)));
    ignored = uniquePaths(oldVideo.ignored_subtitles);
  } else {
    // If the user edits a legacy list before its first scan, retained entries
    // are preserved as manual and removed entries become tombstones. That is
    // the only safe interpretation without historical scan information.
    detected = [];
    manual = oldVisible.slice();
    ignored = [];
  }

  const oldKeys = new Set(oldVisible.map(pathKey));
  const newKeys = new Set(newVisible.map(pathKey));

  for (const oldSubtitle of oldVisible) {
    const key = pathKey(oldSubtitle);
    if (newKeys.has(key)) continue;
    manual = manual.filter(value => pathKey(value) !== key);
    // Tombstone every deliberate removal, not only paths that are automatic
    // today. A manually added path might become discoverable after a later
    // watchfolder or matching change and still must not silently return.
    ignored.push(oldSubtitle);
  }

  for (const newSubtitle of newVisible) {
    const key = pathKey(newSubtitle);
    if (oldKeys.has(key)) continue;
    manual.push(newSubtitle);
    ignored = ignored.filter(value => pathKey(value) !== key);
  }

  manual = uniquePaths(manual);
  const manualKeys = new Set(manual.map(pathKey));
  ignored = uniquePaths(ignored).filter(value => !manualKeys.has(pathKey(value)));

  newVideo.subtitles = newVisible;
  newVideo.detected_subtitles = detected;
  newVideo.manual_subtitles = manual;
  newVideo.ignored_subtitles = ignored;
  newVideo.subtitle_tracking_initialized = true;
  return newVideo;
}

module.exports = {
  subtitleExtensions,
  matchWatchfolderSubtitles,
  prepareSubtitleMatches,
  buildLegacySubtitleCounts,
  reconcileVideoSubtitles,
  trackManualSubtitleEdit,
  pathKey,
  uniquePaths
};
