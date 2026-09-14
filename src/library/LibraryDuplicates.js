const path = require('path');

function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function duplicatePathKey(filepath, platform = process.platform) {
  if (typeof filepath !== 'string' || !filepath.trim()) return '';
  const api = pathApi(platform);
  const normalized = api.resolve(filepath.trim());
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Duplicate paths are persisted as ordinary absolute strings. Normalize old
// or renderer-supplied values before displaying or saving them: discard empty
// and relative entries, remove the selected library copy itself, and collapse
// repeated paths (case-insensitively on Windows).
function normalizeDuplicatePaths(paths, primaryPath = '', platform = process.platform) {
  if (!Array.isArray(paths)) return [];

  const api = pathApi(platform);
  const primaryKey = duplicatePathKey(primaryPath, platform);
  const seen = new Set();
  const normalized = [];

  paths.forEach(candidate => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const displayPath = api.normalize(candidate.trim());
    if (!api.isAbsolute(displayPath)) return;
    const key = duplicatePathKey(displayPath, platform);
    if (!key || key === primaryKey || seen.has(key)) return;
    seen.add(key);
    normalized.push(displayPath);
  });

  return normalized;
}

class ScanDuplicateTracker {
  constructor(videos = [], isUnavailable = () => false, platform = process.platform) {
    this.platform = platform;
    this.pathsByVideoID = new Map();

    (Array.isArray(videos) ? videos : []).forEach(video => {
      if (!video || typeof video.id !== 'string' || !video.id) return;
      const retained = normalizeDuplicatePaths(
        video.duplicates,
        video.filename,
        this.platform
      ).filter(filepath => {
        try {
          return Boolean(isUnavailable(filepath));
        } catch(err) {
          return false;
        }
      });
      this.pathsByVideoID.set(video.id, retained);
    });
  }

  record(videoID, filepath) {
    if (typeof videoID !== 'string' || !videoID) return false;
    const existing = this.pathsByVideoID.get(videoID) || [];
    const updated = normalizeDuplicatePaths(
      existing.concat([filepath]),
      '',
      this.platform
    );
    this.pathsByVideoID.set(videoID, updated);
    return updated.length > existing.length;
  }

  pathsFor(videoID, primaryPath = '') {
    return normalizeDuplicatePaths(
      this.pathsByVideoID.get(videoID) || [],
      primaryPath,
      this.platform
    );
  }

  apply(videos) {
    return (Array.isArray(videos) ? videos : []).map(video => {
      if (!video || typeof video !== 'object') return video;
      return Object.assign({}, video, {
        duplicates: this.pathsFor(video.id, video.filename)
      });
    });
  }
}

module.exports = {
  duplicatePathKey,
  normalizeDuplicatePaths,
  ScanDuplicateTracker
};
