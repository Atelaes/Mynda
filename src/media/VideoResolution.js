// Resolution is a presentation of stored technical metadata, never a second
// saved value. Keep the bucket identity, label, rank, and cutoffs together.
const RESOLUTION_TIERS = Object.freeze([
  {id: '8k', label: '8K', rank: 9, minShort: 4104, minLong: 7296},
  {id: '4k', label: '4K', rank: 8, minShort: 2052, minLong: 3648},
  {id: '1440', label: '1440p', rank: 7, minShort: 1368, minLong: 2432},
  {id: '1080', label: '1080p', rank: 6, minShort: 1026, minLong: 1824},
  {id: '720', label: '720p', rank: 5, minShort: 684, minLong: 1216},
  {id: '576', label: '576p', rank: 4, minShort: 548, minLong: 973},
  {id: '480', label: '480p', rank: 3, minShort: 456, minLong: 812},
  {id: '360', label: '360p', rank: 2, minShort: 342, minLong: 608},
  {id: '240', label: '240p', rank: 1, minShort: 228, minLong: 405},
  {id: 'low', label: 'Below 240p', rank: 0, minShort: 0, minLong: 0},
  {id: 'unknown', label: 'Unknown', rank: -1}
].map(Object.freeze));
const RESOLUTION_BUCKETS = Object.freeze(RESOLUTION_TIERS.map(tier => tier.label));
const UNKNOWN = RESOLUTION_TIERS[RESOLUTION_TIERS.length - 1];

function positiveDimension(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function positiveRatio(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*[:/]\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return 0;
  const ratio = Number(match[1]) / (match[2] === undefined ? 1 : Number(match[2]));
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

function isUnverifiedMjpeg(metadata) {
  return Boolean(metadata && /\bmjpeg\b/i.test(metadata.codec || '') &&
    metadata.video_stream_selected !== true);
}

function getResolutionInfo(metadata) {
  const width = positiveDimension(metadata && metadata.width);
  const height = positiveDimension(metadata && metadata.height);
  const unknown = () => ({
    id: UNKNOWN.id, label: UNKNOWN.label, rank: UNKNOWN.rank,
    width, height, title: 'Resolution unavailable'
  });
  if (!width || !height || metadata.video_stream_selected === false || isUnverifiedMjpeg(metadata)) {
    return unknown();
  }

  // Prefer pixel aspect ratio when present; older libraries kept only DAR.
  // Preserve stored height while undoing horizontal anamorphic squeezing.
  const sar = positiveRatio(metadata.sample_aspect_ratio);
  const dar = positiveRatio(metadata.aspect_ratio) || positiveRatio(metadata.display_aspect_ratio);
  const displayWidth = sar ? width * sar : (dar ? height * dar : width);
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) return unknown();
  const shortEdge = Math.min(displayWidth, height);
  const longEdge = Math.max(displayWidth, height);
  const allowCroppedWidth = longEdge / shortEdge <= 3;
  const tier = RESOLUTION_TIERS.find(candidate =>
    shortEdge >= candidate.minShort ||
    (allowCroppedWidth && longEdge >= candidate.minLong)
  );
  const displayNote = Math.abs(displayWidth - width) >= 1 ?
    ` (display ${Math.round(displayWidth)} × ${height})` : '';
  return {
    id: tier.id, label: tier.label, rank: tier.rank,
    width, height, title: `${width} × ${height} pixels${displayNote}`
  };
}

module.exports = {
  RESOLUTION_TIERS,
  RESOLUTION_BUCKETS,
  positiveDimension,
  positiveRatio,
  isUnverifiedMjpeg,
  getResolutionInfo
};
