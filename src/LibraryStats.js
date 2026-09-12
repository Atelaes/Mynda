const {normalizeDuplicatePaths} = require('./LibraryDuplicates.js');
const {RESOLUTION_BUCKETS, getResolutionInfo} = require('./VideoResolution.js');

function percentage(part, total) {
  const numericPart = Number(part);
  const numericTotal = Number(total);
  if (!Number.isFinite(numericPart) || !Number.isFinite(numericTotal) || numericTotal <= 0) {
    return 0;
  }
  return Math.round((numericPart / numericTotal) * 1000) / 10;
}

function formatPercentage(part, total) {
  const value = percentage(part, total);
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function resolutionBucket(video) {
  return getResolutionInfo(video && video.metadata).label;
}

function buildLibraryStats(videos, platform = process.platform) {
  const validVideos = (Array.isArray(videos) ? videos : []).filter(video =>
    video && typeof video === 'object'
  );
  const kindGroups = new Map();
  const resolutionCounts = new Map(RESOLUTION_BUCKETS.map(label => [label, 0]));
  const duplicateVideos = [];
  let seenCount = 0;
  let duplicateCount = 0;

  validVideos.forEach(video => {
    const kind = typeof video.kind === 'string' ? video.kind.trim() : '';
    if (!kindGroups.has(kind)) {
      kindGroups.set(kind, {
        value: kind,
        count: 0,
        seenCount: 0,
        seriesTitles: new Set()
      });
    }

    const group = kindGroups.get(kind);
    group.count++;
    if (video.seen === true) {
      group.seenCount++;
      seenCount++;
    }

    // Match MynLibSeries exactly: any truthy string is a series key, and the
    // user's displayed title—not an IMDb identifier—defines its identity.
    if (typeof video.series === 'string' && video.series) {
      group.seriesTitles.add(video.series);
    }

    const resolution = resolutionBucket(video);
    resolutionCounts.set(resolution, resolutionCounts.get(resolution) + 1);

    const duplicatePaths = normalizeDuplicatePaths(
      video.duplicates,
      video.filename,
      platform
    );
    duplicateCount += duplicatePaths.length;
    if (duplicatePaths.length > 0) {
      duplicateVideos.push({video: video, paths: duplicatePaths});
    }
  });

  const videoCount = validVideos.length;
  const unseenCount = videoCount - seenCount;
  const kinds = Array.from(kindGroups.values()).map(group => ({
    value: group.value,
    count: group.count,
    seriesCount: group.seriesTitles.size,
    seenCount: group.seenCount,
    unseenCount: group.count - group.seenCount
  }));
  const resolutions = RESOLUTION_BUCKETS.map(label => ({
    value: label,
    count: resolutionCounts.get(label),
    percentage: percentage(resolutionCounts.get(label), videoCount)
  }));

  return {
    videoCount,
    seenCount,
    unseenCount,
    kinds,
    resolutions,
    duplicateCount,
    duplicateVideos
  };
}

module.exports = {
  RESOLUTION_BUCKETS,
  percentage,
  formatPercentage,
  resolutionBucket,
  buildLibraryStats
};
