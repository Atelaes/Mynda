// Both comparisons use current tags, never the video's filename. Strict equality
// is for choosing a different episode; the forgiving assessment only checks the
// plausibility of the episode already requested by number.
const {parseRuntimeMinutes} = require('./MovieSearch.js');

// Produces a deliberately strict comparison key for episode titles. It ignores
// punctuation and a few display-only conventions, including "Chapter 4: Title",
// "Chapter Four 'Title'", and equivalent part suffixes such as "(1)" versus
// "Part I". Unlike series matching, it does not use substring or edit-distance
// matching: a nearby episode number is accepted only when the titles clearly
// agree.
function comparableEpisodeTitle(title) {
  let normalized = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // Some shows use an editorial chapter wrapper around the real episode title.
  // Heroes, for example, is returned by OMDb as "Chapter One 'Genesis'" even
  // when the release filename contains only "Genesis". Treat the wrapper as
  // presentation text, but require a numeric/number-word chapter and either a
  // clear separator or balanced-looking quotation marks. This remains much
  // stricter than accepting an arbitrary substring of an episode title.
  const smallNumber = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
  const tensNumber = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?';
  const chapterNumber = `(?:\\d{1,3}|${smallNumber}|${tensNumber})`;
  normalized = normalized.replace(
    new RegExp(`^\\s*(?:episode|chapter)\\s+${chapterNumber}\\s+['\"“‘](.+)['\"”’]\\s*$`, 'i'),
    '$1'
  );
  normalized = normalized.replace(
    new RegExp(`^\\s*(?:episode|chapter)\\s+${chapterNumber}\\s*[:\\-–—]\\s*`, 'i'),
    ''
  );

  const partNumbers = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    i: 1, ii: 2, iii: 3, iv: 4, v: 5,
    vi: 6, vii: 7, viii: 8, ix: 9, x: 10
  };
  const normalizePartNumber = value => {
    let key = String(value || '').toLowerCase();
    let number = /^\d{1,2}$/.test(key) ? Number(key) : partNumbers[key];
    return number >= 1 && number <= 10 ? number : null;
  };
  const replacePartSuffix = (whole, value) => {
    let number = normalizePartNumber(value);
    return number === null ? whole : ` part ${number}`;
  };

  normalized = normalized.replace(
    /\s*(?:[:\-–—]\s*)?(?:part|pt)\.?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|i{1,3}|iv|v|vi{0,3}|ix|x)\s*$/i,
    replacePartSuffix
  );
  normalized = normalized.replace(
    /\s*[\[(](\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|i{1,3}|iv|v|vi{0,3}|ix|x)[\])]\s*$/i,
    replacePartSuffix
  );

  normalized = normalized.toLowerCase().replace(/&/g, ' and ');
  return normalized.replace(/[^a-z0-9]+/g, '');
}

// Older releases sometimes leave presentation/source flags at the end of the
// title extracted from their filename. For example, the ER files in the user's
// library produce titles such as "Day One FS", "Chicago Heat WS", and
// "Another Perfect Day FS DVD-SFM". These are not alternate episode titles:
// FS and WS mean fullscreen and widescreen, while the following tokens describe
// the audio, disc/source, encoder, or codec.
//
// Keep this deliberately narrower than the general filename parser. A suffix is
// removable only when it starts with the standalone FS or WS release flag, and
// every later token is also recognized technical metadata. Unknown trailing
// words are preserved, so "Day One fan edit" cannot become a match for OMDb's
// "Day One" merely because the beginning happens to agree.
function stripTrailingEpisodeReleaseFlags(title) {
  let original = String(title || '').trim();
  let stripped = original.replace(
    /[\s._-]+(?:fs|ws)(?:[\s._-]+(?:ac-?3|eac-?3|aac|dvd(?:rip)?|sfm|smis|xvid|x26[45]|h26[45]|hevc))*\s*$/i,
    ''
  ).trim();

  // Never turn a title made entirely from release flags into an empty match.
  return stripped ? stripped : original;
}

// Some episode filenames identify the film or program shown in the episode by
// appending its release year, while OMDb stores only the episode title. This is
// especially common for anthology and hosted-film shows (for example,
// "The Crawling Eye (1958)"). Remove only one final parenthesized/bracketed
// four-digit year or year range, and use the result for comparison only. A year
// in ordinary title text remains untouched and the video's stored title is
// never changed.
function stripTrailingEpisodeReleaseYear(title) {
  let original = String(title || '').trim();
  let stripped = original.replace(
    /\s*(?:\((?:18|19|20)\d{2}(?:\s*[-–—]\s*(?:18|19|20)\d{2})?\)|\[(?:18|19|20)\d{2}(?:\s*[-–—]\s*(?:18|19|20)\d{2})?\])\s*$/,
    ''
  ).trim();
  return stripped ? stripped : original;
}

function episodeTitlesMatch(localTitle, omdbTitle) {
  let local = comparableEpisodeTitle(localTitle);
  let omdb = comparableEpisodeTitle(omdbTitle);
  if (!local || !omdb) {
    return false;
  }
  if (local === omdb) {
    return true;
  }

  // Only the local filename-derived title can contain release flags or a
  // trailing source-title year. Try every conservative combination, but still
  // require exact normalized equality. The four-character minimum retains
  // useful short titles such as ER's "Home FS" while rejecting very weak one-
  // or two-letter evidence produced by stripping a suffix.
  let localVariants = new Set();
  let withoutReleaseFlags = stripTrailingEpisodeReleaseFlags(localTitle);
  let withoutReleaseYear = stripTrailingEpisodeReleaseYear(localTitle);
  localVariants.add(withoutReleaseFlags);
  localVariants.add(withoutReleaseYear);
  localVariants.add(stripTrailingEpisodeReleaseYear(withoutReleaseFlags));
  localVariants.add(stripTrailingEpisodeReleaseFlags(withoutReleaseYear));

  for (let variant of localVariants) {
    let comparableVariant = comparableEpisodeTitle(variant);
    if (comparableVariant.length >= 4 && comparableVariant !== local &&
        comparableVariant === omdb) {
      return true;
    }
  }
  return false;
}

// Cap comparison work for malformed tags. Normal episode titles are much
// shorter; a huge or non-Latin tag is inconclusive, never negative evidence.
const MAX_TITLE_LENGTH = 400;
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with']);

function titleText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function usefulEpisodeTitle(value, series = '') {
  const title = titleText(value);
  if (!title || title.length > MAX_TITLE_LENGTH || /^(?:n\/?a|unknown|untitled|tba|tbd)$/i.test(title)) return null;
  let evidence = title;
  // Recognize placeholder TAGS left by detection; do not consult a filename to
  // decide whether a deliberately edited title is allowed to count as evidence.
  const seriesWords = titleText(series).replace(/\s*\((?:19|20)\d{2}[^)]*\)\s*$/, '');
  if (seriesWords && evidence.toLowerCase().startsWith(seriesWords.toLowerCase())) {
    const rest = evidence.slice(seriesWords.length);
    if (/^[\s._-]*(?:s\d+|season\b|episode\b|ep\d|\d)/i.test(rest)) evidence = rest;
  }
  evidence = evidence.replace(/\b(?:season\s*\d+\s*)?(?:episode|ep|part)\s*[#._-]?\s*\d+(?:[._-]\d+)*\b/gi, '');
  evidence = evidence.replace(/\bs\d+[\s._-]*e\d+(?:[\s._-]*e?\d+)*\b/gi, '');
  evidence = evidence.replace(/\b(?:\d{3,4}[pi]|[hx]26[45]|hevc|web[._ -]?(?:dl|rip)|blu[._ -]?ray|dvd[._ -]?rip|aac|ac3|10bit)\b/gi, '');
  return /[a-z\u00c0-\uffff]{3}/i.test(evidence) ? title : null;
}

function editDistance(a, b) {
  let previous = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function sanityParts(value) {
  let text = titleText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  text = stripTrailingEpisodeReleaseYear(stripTrailingEpisodeReleaseFlags(text));
  // The detector historically leaves additional episode numbers at the start
  // of a combined-episode title. These do not describe different subject matter.
  text = text.replace(/^(?:(?:\d{1,2}\.\d{1,3}|s\d+e\d+)\s*[-–—]\s*)+/i, '');
  text = text.replace(/^\s*(?:episode|chapter)\s+(?:\d+|[a-z]+(?:[ -][a-z]+)?)\s*(?:[:–—-]\s*|['"“‘])(.+?)['"”’]?\s*$/i, '$1');
  const key = comparableEpisodeTitle(text);
  const suffix = key.match(/part(\d+)$/);
  // A bare trailing Roman numeral is another spelling of an episode part.
  const roman = text.match(/\s+(I|II|III|IV|V|VI|VII|VIII|IX|X)\s*$/);
  const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const explicitPart = text.match(/\b(?:part|pt)\.?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)\b/i);
  const numbers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const partValue = explicitPart && explicitPart[1].toLowerCase();
  const namedPart = partValue && (numbers.indexOf(partValue) + 1 || romans.indexOf(partValue.toUpperCase()) + 1);
  const part = suffix ? Number(suffix[1]) : explicitPart ? Number(partValue) || namedPart : roman ? romans.indexOf(roman[1]) + 1 : null;
  if (part !== null) {
    text = text.replace(/\s*(?:[(:–—-]\s*)?(?:part|pt)\.?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)[\])]?[\s]*$/i, '');
    text = text.replace(/\s*[\[(](?:\d+|[ivx]+)[\])]\s*$/i, '');
    if (roman) text = text.slice(0, roman.index);
  }
  const words = (text.toLowerCase().replace(/&/g, ' and ').match(/[a-z0-9]+/g) || [])
    .filter(word => !STOP_WORDS.has(word));
  return {words, key: words.join(''), part, numbers: words.filter(word => /^\d+$/.test(word))};
}

function assessEpisodeTitle(localTitle, omdbTitle, series = '') {
  const local = usefulEpisodeTitle(localTitle, series);
  const remote = usefulEpisodeTitle(omdbTitle);
  const result = (state, reason) => ({state, reason});
  // An introduction/bonus label is positive contrary evidence, even when the
  // returned regular episode has only a placeholder title. Exact matching bonus
  // records remain possible; this never removes the clip from the library.
  const bonusLabel = value => /^(?:log[ ._-]*lady(?:\s+intro(?:duction)?s?)?|(?:episode\s+)?intro(?:duction)?|deleted scenes?|behind the scenes|making of|surviving clips)$/i.test(titleText(value));
  if (local && bonusLabel(local) && !bonusLabel(remote)) {
    return result('contradiction', 'introduction or bonus title does not describe the returned episode');
  }
  if (!local || !remote) return result('inconclusive', 'missing or generic episode title');
  if (episodeTitlesMatch(local, remote)) return result('compatible', 'exact normalized title');
  // A reviewed alternate in Torgo's library. Keep the mapping series-specific
  // and outside the strict correction matcher: it must not choose a new number.
  if (comparableEpisodeTitle(series) === 'seinfeld' &&
      [local, remote].map(comparableEpisodeTitle).sort().join('|') === 'thechronicle|theclipshow') {
    return result('compatible', 'established series-specific alternate title');
  }
  // Do not transliterate a different script into an empty/partial English title.
  if (/[^\u0000-\u024f\u0300-\u036f\u2000-\u206f]/.test(local + remote)) {
    return result('inconclusive', 'title uses a different writing system');
  }
  const a = sanityParts(local);
  const b = sanityParts(remote);
  if (!a.key || !b.key) return result('inconclusive', 'insufficient title words');
  if (a.part !== null && b.part !== null && a.part !== b.part) {
    return result('contradiction', 'different episode part numbers');
  }
  if (a.numbers.length && b.numbers.length && a.part === null && b.part === null &&
      a.words.filter(word => !/^\d+$/.test(word)).join('|') === b.words.filter(word => !/^\d+$/.test(word)).join('|') &&
      a.numbers.join('|') !== b.numbers.join('|')) {
    return result('contradiction', 'different meaningful title numbers');
  }
  if (a.key === b.key) return result('compatible', 'presentation or part-label variation');
  const length = Math.max(a.key.length, b.key.length);
  const distance = editDistance(a.key, b.key);
  const allowedEdits = length >= 24 ? 3 : length >= 12 ? 2 : length >= 5 ? 1 : 0;
  if (distance <= allowedEdits) return result('compatible', 'small spelling variation');
  const common = a.words.filter(word => b.words.some(other => word === other ||
    (Math.min(word.length, other.length) >= 5 && editDistance(word, other) <= 1)));
  if (common.length === Math.min(a.words.length, b.words.length) && common.length >= 2) {
    return result('compatible', 'substantial abbreviated or combined title');
  }
  if (common.length || distance / length < 0.55) {
    return result('inconclusive', 'partial title agreement or possible alternate wording');
  }
  // Very short one-word titles provide too little evidence for a veto.
  if (Math.min(a.key.length, b.key.length) < 4) return result('inconclusive', 'short title');
  return result('contradiction', 'unrelated episode titles');
}

function assessEpisodeRuntime(video, episodeData) {
  const seconds = Number(video && video.metadata && video.metadata.duration);
  const localMinutes = Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
  const omdbMinutes = parseRuntimeMinutes(episodeData && episodeData.Runtime);
  const result = {state: 'inconclusive', localMinutes, omdbMinutes};
  if (!localMinutes || !omdbMinutes || (video && video.dvd)) return result;
  const title = titleText(video && video.title);
  // Split/combined evidence comes from current tags, not the original path.
  if (/\b(?:part|pt|cd|disc|disk)\s*[. -]?\s*(?:\d+|[ivx]+|one|two)\b/i.test(title) ||
      /\b(?:s\d+e\d+|\d{1,2}\.\d{1,3})\s*(?:[-&+]\s*)?(?:e\d+|\d{1,2}\.\d{1,3})\b/i.test(title)) {
    return {...result, reason: 'split or combined episode tag'};
  }
  const difference = Math.abs(localMinutes - omdbMinutes);
  const ratio = Math.max(localMinutes, omdbMinutes) / Math.min(localMinutes, omdbMinutes);
  // Deliberately broad: a five-minute gap AND more than a fourfold difference.
  // Ordinary edits, short cartoons, half pilots and double episodes survive.
  return {...result, state: difference > 5 && ratio > 4 ? 'contradiction' : 'compatible'};
}

module.exports = {
  comparableEpisodeTitle, episodeTitlesMatch, usefulEpisodeTitle,
  assessEpisodeTitle, assessEpisodeRuntime
};
