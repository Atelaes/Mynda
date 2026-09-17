// Recognize detector/release placeholders in CURRENT title tags. Never consult
// the filename to override an edited title, and never use this as evidence of
// the correct catalog identity. A placeholder is missing evidence, not a match.
const RELEASE_START = /(?:^|[\s._(\[-])(?:(?:multi|proper|repack)[\s._-]+)?(?:\d{3,4}[pi]|hdtv|web(?:[\s._-]?(?:rip|dl))?|blu[\s._-]?ray|dvd[\s._-]?rip|[hx]26[45])(?=$|[^a-z0-9])/i;
const EPISODE_MARKER = /(?:^|[\s._-])(?:s\d+[\s._-]*e\d+(?:[\s._-]*e\d+)*|\d{1,2}x\d{1,3}|(?:episode|ep|e)[\s._-]*\d+)(?=$|[^a-z0-9])/i;

// A resolution/codec at the beginning does not make the rest disposable:
// "1080p fan edit" still contains deliberately edited title evidence. Accept
// only technical fields and known release labels, wherever the block appears.
const {isTechnicalToken} = require('./ReleaseTokens');
const {fold} = require('./TitleNormalization');

function technicalOnly(value) {
  const text = String(value)
    .replace(/h[._ -]?26([45])/gi, 'h26$1')
    // Channel layouts belong to an explicit audio codec, never to bare title
    // numbers. Keep DDP5.1 together instead of interpreting its final 1 alone.
    .replace(/\b(ddp|aac|dts|eac3|ac3)[._ -]?[1257][._][01](?:[._][24])?(?=$|[^a-z0-9])/gi, '$1')
    .replace(/(blu[._ -]?ray)([hx]26[45])/gi, '$1 $2')
    .replace(/\[(?:ettv|eztv|eztvx\.to|eztv\.re|tgx)\]/gi, ' ')
    .replace(/mrs\.sujaidr/gi, 'sujaidr')
    .replace(/shaanig\.com/gi, 'shaanig');
  const tokens = text.split(/[\s._()[\]-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => isTechnicalToken(token,'release'));
}

function seriesKey(value) {
  return fold(value)
    .replace(/\s+-\s+\d+\s+-\s+/g, ' ')
    .replace(/\s*\((?:BBC|ITV)(?:\s*-?\s*(?:19|20)\d{2})?\)\s*$/i, '')
    .replace(/\s*[\[(](?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?[\])]\s*$/, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function releaseTitleInfo(value, series = '') {
  if (typeof value !== 'string' || value.length > 400) return null;
  const text = value.trim();
  const marker = EPISODE_MARKER.exec(text);
  if (!marker) return null;
  const prefix = text.slice(0, marker.index).replace(/[\s._-]+$/, '');
  const rest = text.slice(marker.index + marker[0].length).replace(/^[\s._-]+/, '');
  const suffixRelease = RELEASE_START.exec(rest);
  // No intervening title words may be swallowed by a technical suffix.
  const releaseOnlySuffix = suffixRelease && suffixRelease.index === 0 && technicalOnly(rest);
  if (rest && !releaseOnlySuffix) return null;
  const prefixRelease = RELEASE_START.exec(prefix);
  if (prefixRelease && !technicalOnly(prefix.slice(prefixRelease.index))) return null;
  let name = (prefixRelease ? prefix.slice(0, prefixRelease.index) : prefix).trim();
  const yearMatch = name.match(/(?:^|[\s._(\[-])((?:19|20)\d{2})[\s.)\]_-]*$/);
  const year = yearMatch ? yearMatch[1] : null;
  if (yearMatch) name = name.slice(0, yearMatch.index).replace(/[\s._(-]+$/, '');
  // A broadcaster/year qualifier is attached to the series, not the episode.
  name = name.replace(/\s*\((?:BBC|ITV)(?:\s*-?\s*(?:19|20)\d{2})?\)?\s*$/i, '');
  const expected = seriesKey(series);
  let actual = seriesKey(name);
  const acronym = (String(series).match(/[a-z0-9]+/gi) || []).map(word => word[0]).join('').toLowerCase();
  if (actual !== expected && releaseOnlySuffix && /^[a-z0-9]{2,20}-/i.test(name)) {
    actual = seriesKey(name.replace(/^[a-z0-9]{2,20}-/i, ''));
  }
  // The release can spell out a franchise-qualified series name while the
  // editable series field contains its distinctive suffix. This only removes
  // the placeholder's veto; the series resolver must still prove identity.
  const qualified = releaseOnlySuffix && expected.length >= 8 && actual.endsWith(expected);
  const abbreviated = acronym.length >= 3 && actual === acronym && (prefixRelease || releaseOnlySuffix);
  if (actual && actual !== expected && !qualified && !abbreviated) return null;
  return {placeholder: true, seriesYear: year, marker: marker[0].replace(/^[\s._-]+/, '')};
}

// A detector can leave the series after the episode marker (for example,
// "4x03 Series Name Story"). Keep the original title; this is an alternative
// interpretation for exact comparison, never a substring/fuzzy identity rule.
function repeatedSeriesPrefix(value, series) {
  if (typeof value !== 'string' || value.length > 400 || typeof series !== 'string' || series.length > 400) return null;
  const label = series.trim().replace(/\s*[\[(](?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?[\])]\s*$/, '');
  const words = label.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length || !seriesKey(label)) return null;
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const separators = '[\\s._:,&\'’()\\[\\]–—-]+';
  const boundary = '[\\s._:–—-]+';
  const pattern = new RegExp('^\\s*' + words.map(escape).join(separators) + boundary + '(.+)$', 'iu');
  const matched = pattern.exec(value);
  if (!matched || !/[\p{L}\p{N}]/u.test(matched[1])) return null;
  return {title:matched[1].trim(), originalTitle:value, basis:'repeated-series-prefix'};
}

module.exports = {releaseTitleInfo,repeatedSeriesPrefix,technicalOnly};
