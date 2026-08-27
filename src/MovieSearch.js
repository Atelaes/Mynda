const path = require('path');

// Movie filenames commonly append a release description after the real title.
// Once one of these tokens appears, everything after it is useful to a media
// player but generally harmful to an OMDb title search.
// JavaScript does not support a free-spacing regular-expression flag, so this
// long expression stays compact and is compiled only once.
const RELEASE_TOKEN_COMPACT = /^(?:360p|480p|576p|720p|1080p|1440p|2160p|4k|8k|uhd|blu-?ray|brrip|bdrip|bdremux|webrip|web-?dl|hdrip|dvdrip|dvd|hdtv|remux|cam|telesync|ts|proper|repack|internal|multi|mult[iy]|dual|dubbed|subbed|subs?|aac|ac3|eac3|ddp\d*(?:\.\d+)?|dd\+?\d*(?:\.\d+)?|dts(?:hd|x|ma|hdma)?|truehd|atmos|lpcm|xvid|divx|x26[45]|h\.?26[45]|hevc|avc|hdr(?:10|10\+)?|sdr|dovi|10bit|8bit|\d+(?:\.\d+)?ch|\d+(?:\.\d+)?gb|\d+mb|nf|amzn|hmax|hulu|criterion|stv|hq|eng|ita|fr|en|yify|rarbg)$/i;

const GENERIC_PARENT = /^(?:movies?|videos?|films?|featurettes?|extras?|bonus(?: features?)?|special features?|samples?|screens?|subs?|subtitles?|disc ?\d+|disk ?\d+|cd ?\d+|video_ts)$/i;
const AUXILIARY_PARENT = /^(?:featurettes?|extras?|bonus(?: features?)?|special features?|samples?|screens?|subs?|subtitles?)$/i;
const EDITION_SUFFIX = /\s+(?:(?:the\s+)?(?:theatrical|extended|director'?s?|final|ultimate|special|remastered|criterion|unrated)\s+(?:cut|edition|version)|director'?s?\s+cut|extended|remastered|criterion|unrated|ece|dc|the\s+movie)$/i;
const SAMPLE_BASENAME_SUFFIX = /(?:^|[^a-z0-9])sample(?:[^a-z0-9]*(?:ttl))?[^a-z0-9]*$/i;
const SAMPLE_PATH_COMPONENT = /(?:^|[^a-z0-9])samples?(?:$|[^a-z0-9])/i;
const GARBAGE_BASENAME = /^(?:ETRG|RARBG\.com)$/i;
const TITLE_ARTICLES = new Set(['a', 'an', 'the']);
const TITLE_CONNECTORS = new Set(['a', 'an', 'and', 'at', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const ROMAN_SEQUEL_NUMBERS = {
  1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X'
};
const ARABIC_SEQUEL_NUMBERS = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10
};

function removeDiacritics(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae');
}

// This comparison form deliberately ignores punctuation, capitalization, and
// the common "and" versus "&" discrepancy. It is used only to validate OMDb
// choices; the original display title is still sent to OMDb and shown to users.
function titleKey(value) {
  return removeDiacritics(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:colour)\b/g, 'color')
    .replace(/\b(?:viii)\b/g, '8')
    .replace(/\b(?:vii)\b/g, '7')
    .replace(/\b(?:vi)\b/g, '6')
    .replace(/\b(?:iv)\b/g, '4')
    .replace(/\b(?:iii)\b/g, '3')
    .replace(/\b(?:ii)\b/g, '2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

function titleKeyWithoutArticle(value) {
  return titleKey(String(value || '').replace(/^\s*(?:the|a|an)\s+/i, ''));
}

function titleTokens(value) {
  return removeDiacritics(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bcolour\b/g, 'color')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => Object.prototype.hasOwnProperty.call(ARABIC_SEQUEL_NUMBERS, token) ?
      String(ARABIC_SEQUEL_NUMBERS[token]) : token);
}

function withoutArticles(tokens) {
  return tokens.filter(token => !TITLE_ARTICLES.has(token));
}

function isOrderedSubsequence(shorter, longer) {
  let next = 0;
  for (let token of longer) {
    if (token === shorter[next]) next++;
    if (next === shorter.length) return true;
  }
  return false;
}

function tokenMultisetOverlap(left, right) {
  let remaining = right.slice();
  let overlap = 0;
  for (let token of left) {
    let index = remaining.indexOf(token);
    if (index >= 0) {
      overlap++;
      remaining.splice(index, 1);
    }
  }
  return overlap;
}

// Catalog titles often add or reorder a franchise/subtitle phrase: "Captain
// America" versus "Captain America: The First Avenger", or "Jurassic Park II
// The Lost World" versus "The Lost World: Jurassic Park". This recognizes
// only substantial token containment/overlap. It deliberately refuses a
// one-word bridge such as "Dune" -> "Dune: Part One"; canonical matches must
// also pass tight runtime validation before Auto-Tag can use them.
function canonicalTitleMatches(candidateTitle, resultTitle) {
  let candidateTokens = withoutArticles(titleTokens(candidateTitle));
  let resultTokens = withoutArticles(titleTokens(resultTitle));
  if (!candidateTokens.length || !resultTokens.length) return false;

  let shorter = candidateTokens.length <= resultTokens.length ? candidateTokens : resultTokens;
  let longer = shorter === candidateTokens ? resultTokens : candidateTokens;
  let descriptiveTokens = shorter.filter(token => !TITLE_CONNECTORS.has(token));
  let descriptiveCharacters = descriptiveTokens.join('').length;
  if (descriptiveTokens.length < 2 || descriptiveCharacters < 8) return false;

  if (isOrderedSubsequence(shorter, longer)) return true;

  // A small number of official titles reverse a subtitle/franchise order. A
  // high four-token overlap permits that specific shape without turning this
  // into general fuzzy matching.
  let overlap = tokenMultisetOverlap(candidateTokens, resultTokens);
  let union = candidateTokens.length + resultTokens.length - overlap;
  return overlap >= 4 && overlap / union >= 0.75 &&
    overlap / Math.min(candidateTokens.length, resultTokens.length) >= 0.8;
}

function titlesDifferOnlyByPartLabel(candidateTitle, resultTitle) {
  let normalize = value => withoutArticles(titleTokens(value))
    .filter(token => token !== 'part')
    .join('\u0000');
  let candidate = normalize(candidateTitle);
  let result = normalize(resultTitle);
  return Boolean(candidate && candidate === result);
}

function validYear(value) {
  let stringValue = String(value || '').trim();
  if (!/^(?:18|19|20)\d{2}$/.test(stringValue)) return '';
  return Number(stringValue) <= new Date().getFullYear() + 1 ? stringValue : '';
}

function firstResultYear(value) {
  let match = String(value || '').match(/(?:18|19|20)\d{2}/);
  return match ? match[0] : '';
}

function cleanDisplayText(value) {
  return String(value || '')
    .replace(/[._]+/g, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—,;:]+\s*|\s*[-–—,;:]+$/g, '')
    .trim();
}

// Multi-file encodes often append a disc marker that is not part of the movie
// title. These deliberately narrow forms do not include a bare "Part 1": that
// phrase is common in real titles and in episodic/miniseries filenames.
function stripSplitFileMarkers(value) {
  return String(value || '')
    .replace(/(?:^|\s)[([]?\s*(?:cd|disc|disk)\s*\d{1,2}\s*[)\]]?(?=\s|,|$)/gi, ' ')
    .replace(/(?:^|\s)[([]?\s*part\s*\d{1,2}\s+of\s+\d{1,2}\s*[)\]]?(?=\s|,|$)/gi, ' ')
    .replace(/(?:^|\s)[([]?\s*\d{1,2}\s*(?:of|\/)\s*\d{1,2}\s*[)\]]?(?=\s|,|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSplitFile(video) {
  let filename = typeof video === 'string' ? video : video && video.filename;
  let basename = path.basename(String(filename || ''), path.extname(String(filename || '')));
  return /(?:^|[^a-z0-9])(?:cd|disc|disk)\s*\d{1,2}(?:[^a-z0-9]|$)/i.test(basename) ||
    /(?:^|[^a-z0-9])\d{1,2}\s*(?:of|\/)\s*\d{1,2}(?:[^a-z0-9]|$)/i.test(basename) ||
    /(?:^|[^a-z0-9])part\s*\d{1,2}\s+of\s+\d{1,2}(?:[^a-z0-9]|$)/i.test(basename);
}

// A non-show video can still be an episode or one piece of a miniseries. If a
// parser-derived fallback discards one of these strong markers, auto-selecting
// a same-named feature film is unsafe. The returned numbers let reduced
// candidates prove that they preserved the same marker rather than merely a
// generic word such as "part".
function strongStructuralMarker(value) {
  let source = String(value || '');
  let compact = source.match(/\bs\s*(\d{1,2})[\s._-]*e\s*(\d{1,3})\b/i);
  if (compact) {
    return {type: 'season-episode', season: Number(compact[1]), episode: Number(compact[2])};
  }

  let season = source.match(/\bseason[\s._-]*(\d{1,2})\b/i);
  let episode = source.match(/\bepisode[\s._-]*(\d{1,3})\b/i);
  if (season && episode) {
    return {type: 'season-episode-words', season: Number(season[1]), episode: Number(episode[1])};
  }

  let part = source.match(/\bpart[\s._-]*(\d{1,3})\b/i);
  if (/\bmini[\s._-]*series\b/i.test(source) && part) {
    return {type: 'miniseries-part', part: Number(part[1])};
  }
  // "Episode N" by itself, or set off as a dash-delimited label, is strong
  // structural evidence. Do not treat every embedded occurrence this way:
  // feature titles such as "Star Wars Episode 1 The Phantom Menace" use the
  // same words and must remain eligible for ordinary movie matching.
  let standaloneEpisode = source.match(
    /(?:^|\s[-–—]\s)episode[\s._-]*(\d{1,3})(?=$|\s[-–—]\s)/i
  );
  if (standaloneEpisode) {
    return {type: 'episode', episode: Number(standaloneEpisode[1])};
  }
  return null;
}

function preservesStructuralMarker(value, marker) {
  if (!marker) return true;
  let candidateMarker = strongStructuralMarker(value);
  if (!candidateMarker || candidateMarker.type !== marker.type) return false;
  if (marker.season !== undefined && candidateMarker.season !== marker.season) return false;
  if (marker.episode !== undefined && candidateMarker.episode !== marker.episode) return false;
  if (marker.part !== undefined && candidateMarker.part !== marker.part) return false;
  return true;
}

// Recognizes small release samples and the two known garbage filenames before
// either the watchfolder scanner or Auto-Tag treats them as real movies. The
// sample suffix deliberately permits punctuation, brackets, and the observed
// "_TTL" suffix, but does not match a normal title merely containing "sample".
function basenameLooksLikeSampleOrGarbage(filepath) {
  let filepathString = String(filepath || '');
  let basename = path.basename(filepathString, path.extname(filepathString));
  return SAMPLE_BASENAME_SUFFIX.test(basename) || GARBAGE_BASENAME.test(basename);
}

// A sample can have an ordinary-looking movie basename while living in a
// composite directory such as "Sample,Screens" or "Movie and Sample". Split on
// both platform path separators so diagnostics and tests work with Mac or
// Windows paths regardless of which platform is currently running Mynda.
function pathContainsSampleArea(filepath) {
  let components = String(filepath || '').split(/[\\/]+/).slice(0, -1);
  return components.some(component => SAMPLE_PATH_COMPONENT.test(component));
}

function parentLooksAuxiliary(value) {
  let cleaned = cleanDisplayText(value);
  if (AUXILIARY_PARENT.test(cleaned)) return true;

  // Composite folders made entirely from auxiliary labels (for example,
  // "Sample,Screens") are auxiliary too. If even one part is a real movie
  // label ("Movie and Sample", "Lifeboat + Extras"), keep the parent eligible;
  // the scanner's size-aware sample check will reject only the small clip.
  let parts = cleaned.split(/\s*(?:[,;+&/]|\band\b)\s*/i).filter(Boolean);
  return parts.length > 1 && parts.every(part => AUXILIARY_PARENT.test(part));
}

function collectMatches(value, expression) {
  let matches = [];
  let match;
  expression.lastIndex = 0;
  while ((match = expression.exec(value)) !== null) matches.push(match);
  return matches;
}

function stripLeadingReleaseJunk(value) {
  let result = String(value || '').trim();

  // Torrent sites and release groups sometimes prepend a domain or a compact
  // franchise/sequence label. The separators in these forms are important:
  // we must not mistake legitimate numeric titles such as "12 Monkeys" or
  // "2 Fast 2 Furious" for a collection sequence number.
  result = result.replace(/^\s*(?:\[[^\]]*(?:www\.|\.com|\.to|torrent|bit)[^\]]*\]\s*[-.]?\s*)+/i, '');
  result = result.replace(/^\s*www\.[^\s]+\s*[-–—]\s*/i, '');
  // Numbered disc/collection children such as "1. Six Men Getting Sick" and
  // "1a. Ghost in the Shell" describe the child after the index. Requiring a
  // letter/number suffix plus punctuation and whitespace preserves genuine
  // numeric titles such as "12 Monkeys" and "2 Fast 2 Furious".
  result = result.replace(/^\s*\d{1,2}[a-z]?[.)]\s+/i, '');
  result = result.replace(/^\s*[A-Z][A-Z0-9]{1,7}\s*[-–—]\s*\d+(?:\.\d+)?\s*[-–—]\s*/, '');
  result = result.replace(/^\s*\d{1,2}(?:\.\d+)?\s+[-–—]\s+/, '');
  return result;
}

function releaseTokenBoundary(value) {
  let matches = collectMatches(value, /\S+/g);
  let match = matches.find(item => {
    let token = item[0].replace(/^[()]+|[(),]+$/g, '');
    let tokenParts = token.split('-');
    return RELEASE_TOKEN_COMPACT.test(token) ||
      tokenParts.some(part => RELEASE_TOKEN_COMPACT.test(part)) ||
      /^s\d{1,2}(?:e\d{1,3})?$/i.test(token);
  });
  return match ? match.index : -1;
}

// Returns the most likely release year and the point where the title ends.
// The last plausible year is intentional: numeric movie titles commonly come
// first ("2012.2009..." and "2001 A Space Odyssey 1968..."). A lone leading
// year remains a title, so a file simply named "1917" is not reduced to blank.
function findReleaseYear(value, explicitYear, useDetectedBoundary) {
  let suppliedYear = validYear(explicitYear);
  let matches = collectMatches(value, /\b((?:18|19|20)\d{2})\b/g)
    .filter(match => Number(match[1]) <= new Date().getFullYear() + 1);

  if (suppliedYear) {
    let sameYear = matches.filter(match => match[1] === suppliedYear).pop();
    let boundaryMatch = sameYear || (useDetectedBoundary ? matches[matches.length - 1] : null);
    return {year: suppliedYear, index: boundaryMatch ? boundaryMatch.index : -1};
  }
  if (matches.length === 0) return {year: '', index: -1};
  if (matches.length === 1 && matches[0].index === 0 &&
      cleanDisplayText(value.slice(matches[0][0].length)) === '') {
    return {year: '', index: -1};
  }
  let chosen = matches[matches.length - 1];
  return {year: chosen[1], index: chosen.index};
}

function stripEditionSuffix(value) {
  let result = value.trim();
  let previous;
  do {
    previous = result;
    result = result.replace(EDITION_SUFFIX, '').trim();
  } while (result !== previous);
  return result;
}

function parentheticalLooksLikeAlias(value) {
  let alias = cleanDisplayText(value);
  if (!alias || alias.length < 4 || alias.split(/\s+/).length > 10) return false;
  if (/^(?:18|19|20)\d{2}$/.test(alias)) return false;
  if (/\b(?:director'?s?|extended|theatrical|unrated|remaster(?:ed)?|edition|cut|version|sample|rip|encode|audio|subs?|commentary)\b/i.test(alias)) {
    return false;
  }
  return /[a-z]{2}/i.test(alias);
}

function replaceSequelNumber(title) {
  let original = String(title || '');
  // Preserve intentionally numeric titles such as "2 Fast 2 Furious".
  if (/^\s*(?:[1-9]|10)\b/.test(original)) return '';

  let matches = collectMatches(original, /\b(?:10|[1-9]|viii|vii|vi|iv|iii|ii|ix|x|i)\b/gi);
  for (let match of matches) {
    let before = original.slice(0, match.index);
    let after = original.slice(match.index + match[0].length);
    let precedingWords = titleTokens(before);
    let previousWord = precedingWords[precedingWords.length - 1] || '';
    let followsSeriesLabel = /^(?:episode|part|chapter|volume)$/i.test(previousWord);
    let atTitleEnd = after.trim() === '';
    let beforeSubtitleSeparator = /^\s*[-:–—]/.test(after);
    let betweenTitleAndSubtitle = precedingWords.length >= 2 && /[a-z]/i.test(after);
    if (!precedingWords.length || TITLE_CONNECTORS.has(previousWord)) continue;
    if (!followsSeriesLabel && !atTitleEnd && !beforeSubtitleSeparator && !betweenTitleAndSubtitle) continue;

    let lower = match[0].toLowerCase();
    let replacement = /^\d+$/.test(match[0]) ?
      ROMAN_SEQUEL_NUMBERS[Number(match[0])] :
      String(ARABIC_SEQUEL_NUMBERS[lower]);
    if (replacement) {
      return original.slice(0, match.index) + replacement + after;
    }
  }
  return '';
}

// Generates a few spelling/order alternatives that OMDb's search endpoint
// does not consistently infer. These are discovery queries only: every result
// still needs exact/canonical title evidence plus the normal year/type checks
// and, for a canonical expansion, a tightly matching full-record runtime.
function buildTitleQueryVariants(value) {
  let original = String(value || '').trim();
  let variants = [];
  function add(title, reason) {
    title = cleanDisplayText(title);
    if (!title || title.toLowerCase() === original.toLowerCase()) return;
    if (!variants.some(item => item.title.toLowerCase() === title.toLowerCase())) {
      variants.push({title: title, reason: reason});
    }
  }

  let trailingArticle = original.match(/^(.+?),\s*(the|a|an)$/i);
  if (trailingArticle) {
    add(`${trailingArticle[2]} ${trailingArticle[1]}`, 'moved trailing article');
  }

  let numeralVariant = replaceSequelNumber(original);
  if (numeralVariant) add(numeralVariant, 'converted sequel numeral');

  let completeParentheticals = collectMatches(original, /\(([^()]*)\)/g);
  if (completeParentheticals.length > 0) {
    for (let match of completeParentheticals) {
      let alias = cleanDisplayText(match[1]);
      if (!parentheticalLooksLikeAlias(alias)) continue;
      let before = original.slice(0, match.index).trim();
      let after = original.slice(match.index + match[0].length).trim();

      // A final parenthetical commonly supplies an English/original-title
      // alias: "Der Untergang (Downfall)". Try the alias by itself.
      if (!after) add(alias, 'used final parenthetical alias');

      // An inline parenthetical can be an alternate spelling for the word
      // immediately before it: "Thirteen (Thir13en) Ghosts". Replacing just
      // that word keeps the surrounding title rather than issuing a vague
      // search for the alias alone.
      let precedingWord = before.match(/^(.*?)([A-Za-z0-9À-ž'’-]+)$/);
      if (precedingWord && after) {
        add(`${precedingWord[1]}${alias} ${after}`, 'used inline parenthetical alias');
      }
    }

    // Removing the qualifier is useful when it is release/director metadata,
    // but a clearly title-like alias is the more informative retry and stays
    // ahead of this generic cleanup in the bounded request plan.
    add(original.replace(/\s*\([^()]*\)\s*/g, ' '), 'removed parenthetical qualifier');
  }

  // A year inside an unclosed parenthesis becomes the title boundary during
  // filename parsing (for example, "Husbands and Wives (Woody Allen 1992").
  // Removing only that dangling suffix is safer than guessing which words in
  // it are a title alias.
  let danglingParenthetical = original.match(/^(.+?)\s*\([^)]*$/);
  if (danglingParenthetical) {
    add(danglingParenthetical[1], 'removed dangling parenthetical qualifier');
  }
  return variants;
}

// OMDb's search endpoint is unexpectedly sensitive to punctuation that our
// normal comparison intentionally ignores. For example, searches for
// "Oceans Eleven" and "The Kings Speech" can return nothing even though the
// catalog contains "Ocean's Eleven" and "The King's Speech". These variants
// are used only after every ordinary title query has failed to expose an exact
// normalized match. They broaden discovery, never acceptance: the caller must
// still compare every returned row with the complete, unreduced candidate.
function buildNormalizedDiscoveryQueries(value) {
  let original = String(value || '').replace(/\s+/g, ' ').trim();
  if (!original) return [];

  let repaired = removeDiacritics(original)
    // A dot-separated filename loses both camel-case and catalog punctuation
    // during ordinary cleanup. Restore only shapes whose intended separator is
    // reasonably clear; a wrong repair merely produces an unsuccessful query.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^(\d)(\d{2})(?=\s|$)/, '$1:$2')
    .replace(/\b(\d)\s+(\d)\b/g, '$1.$2')
    .replace(/\b([A-Za-z])\s*[- ]?\s*(\d{1,2})\b/g, '$1-$2')
    .replace(/\b((?:[A-Za-z]\s+){1,}[A-Za-z])\b/g, letters =>
      letters.trim().split(/\s+/).map(letter => `${letter.toUpperCase()}.`).join(''))
    .replace(/\b([LD])\s+([A-Za-zÀ-ž]+)/g, "$1'$2");

  // A few common contractions are unambiguous in a title. Most remaining
  // punctuation-loss failures are possessives; choosing the rightmost eligible
  // word works for forms such as "Pirates ... Worlds End" without generating
  // a combinatorial set of apostrophe guesses.
  const contractions = {
    its: "It's",
    shes: "She's",
    hes: "He's",
    youve: "You've",
    theyve: "They've",
    ive: "I've"
  };
  repaired = repaired.replace(/\b[A-Za-z]+\b/g, word => contractions[word.toLowerCase()] || word);

  let possessives = collectMatches(repaired, /\b([A-Za-zÀ-ž][A-Za-zÀ-ž’'-]*s)\b(?=\s+[A-Za-z0-9])/gi)
    .filter(match => match[1].length >= 4 && !/[’']s$/i.test(match[1]));
  if (possessives.length > 0) {
    let match = possessives[possessives.length - 1];
    let word = match[1];
    repaired = repaired.slice(0, match.index) + `${word.slice(0, -1)}'s` +
      repaired.slice(match.index + word.length);
  } else {
    // A final place/name after a preposition can be possessive with its noun
    // implied, as in "Breakfast at Tiffany's".
    repaired = repaired.replace(
      /\b(at|from|of)\s+([A-Za-zÀ-ž][A-Za-zÀ-ž’'-]{2,}s)$/i,
      (whole, preposition, word) => `${preposition} ${word.slice(0, -1)}'s`
    );
  }

  // Compact catalog labels commonly contain a joined final name (K-19: The
  // Widowmaker). Restrict this spelling guess to titles beginning with an
  // alphanumeric label; the full normalized-title check makes it harmless if
  // the guess was unnecessary.
  if (/^[A-Za-z]-\d{1,2}\b/.test(repaired)) {
    repaired = repaired.replace(/\b([A-Za-z]{4,})\s+([A-Za-z]{4,})$/, '$1$2');
  }
  repaired = repaired.replace(/\s+/g, ' ').trim();

  let queries = [];
  function add(title, reason) {
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.toLowerCase() === original.toLowerCase()) return;
    if (!queries.some(query => query.title.toLowerCase() === title.toLowerCase())) {
      queries.push({title: title, reason: reason});
    }
  }
  add(repaired, 'restored likely catalog punctuation');

  // If the repaired full title is still too literal for OMDb, one compact
  // keyword query can surface its row. This never authorizes a partial-title
  // match: the response must still equal the original full title after strict
  // normalization, and normal year/type/runtime checks still apply.
  let fragmentWords = repaired.split(/\s+/).filter(word => {
    let key = removeDiacritics(word).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return key && !TITLE_CONNECTORS.has(key);
  });
  if (fragmentWords.length > 5) {
    fragmentWords = fragmentWords.slice(0, 3).concat(fragmentWords.slice(-2));
  }
  add(fragmentWords.join(' '), 'used distinctive normalized-title keywords');
  return queries.slice(0, 2);
}

function deriveCandidates(value, source, explicitYear) {
  let structuralMarker = strongStructuralMarker(value);
  let cleaned = stripSplitFileMarkers(cleanDisplayText(stripLeadingReleaseJunk(value)));
  if (!cleaned) return [];

  // A deliberately edited title can contain a number that is part of the title
  // (for example, "2001: A Space Odyssey"), so only filenames/folders use a
  // different embedded year as their structural boundary when the user has
  // supplied a corrected year explicitly.
  let year = findReleaseYear(cleaned, explicitYear, source !== 'video title');
  let boundary = year.index >= 0 ? year.index : releaseTokenBoundary(cleaned);
  let title = boundary >= 0 ? cleaned.slice(0, boundary) : cleaned;
  title = title.replace(/[\s([{:-]+$/g, '').trim();
  title = stripEditionSuffix(title);

  let candidates = [];
  function add(candidate, reason) {
    candidate = cleanDisplayText(candidate)
      .replace(/\s+[-–—]\s+\d+(?:\.\d+)?\s+[-–—]\s+/g, ' ')
      .replace(/[\s([{:-]+$/g, '')
      .trim();
    if (!candidate || !titleKey(candidate)) return;
    if (!preservesStructuralMarker(candidate, structuralMarker)) return;
    if (!candidates.some(existing => titleKey(existing.title) === titleKey(candidate))) {
      candidates.push({title: candidate, year: year.year, source: source, reason: reason});
    }
  }

  // A smaller set of hand-organized files uses "Actor - 1944 - Title".
  // The normal year boundary correctly removes the actor but would otherwise
  // discard the actual title as well, so retain the post-year segment.
  let addedPostYearTitle = false;
  if (year.index >= 0) {
    let afterYear = cleaned.slice(year.index + year.year.length)
      .replace(/^\s*[-–—]\s*/, '');
    let afterBoundary = releaseTokenBoundary(afterYear);
    if (afterBoundary >= 0) afterYear = afterYear.slice(0, afterBoundary);
    if (/^\s*[-–—]/.test(cleaned.slice(year.index + year.year.length)) ||
        /\s[-–—]\s*$/.test(cleaned.slice(0, year.index))) {
      add(stripEditionSuffix(afterYear), 'after year separator');
      addedPostYearTitle = candidates.length > 0;
    }
  }
  add(title, addedPostYearTitle ? 'before year separator' : 'cleaned full title');

  // Collection folders often look like "MI - 02 - Mission Impossible II".
  // Keep both the franchise-qualified and post-number forms because either can
  // be OMDb's canonical title, while never deleting an unseparated title number.
  let numbered = title.match(/^(.*?)\s+[-–—]\s+\d+(?:\.\d+)?\s+[-–—]\s+(.+)$/);
  if (numbered) {
    add(`${numbered[1]} ${numbered[2]}`, 'without collection sequence number');
    add(numbered[2], 'after collection sequence number');
  }

  // A dash may separate a director/franchise label from the actual movie, or
  // append an actor/release note after it. Trying each edge is conservative;
  // either still has to exactly match an OMDb result before auto-tag accepts it.
  let dashParts = title.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);
  if (dashParts.length > 1) {
    // In the uploaded corpus, a leading director/franchise label was more
    // commonly the expendable half ("Fellini - Satyricon", "FATF - Fast
    // Five"). Try the specific trailing title before the generic prefix. The
    // full title remains first, and the prefix is still retained as a fallback.
    add(dashParts[dashParts.length - 1], 'after dash prefix');
    add(dashParts[0], 'before dash suffix');
  }
  return candidates;
}

function isGenericParent(value) {
  let cleaned = cleanDisplayText(value);
  return GENERIC_PARENT.test(cleaned) ||
    /^(?:season|series|collection|complete)\b/i.test(cleaned);
}

function parentLooksLikeCollection(value) {
  return /(?:18|19|20)\d{2}\s*[-–—]\s*(?:18|19|20)\d{2}/.test(value) ||
    /\b(?:trilogy|quadrilogy|anthology|collection|complete|franchise)\b/i.test(value) ||
    /^\s*[A-Z][A-Z0-9]{1,7}\s*[-–—]\s*/.test(value);
}

function candidateLooksOpaque(candidate) {
  if (!candidate) return true;
  let key = titleKey(candidate.title);
  return key.length < 4 || (!/\s/.test(candidate.title) && /^[a-z0-9-]{10,}$/i.test(candidate.title));
}

// Builds a short, ordered search plan before any network request is made.
// A deliberately edited title wins. Otherwise, a clean parent folder with a
// release year is often more descriptive than an obfuscated torrent filename;
// normal filenames remain ahead of noisy/generic folders.
function buildSearchCandidates(video) {
  video = video || {};
  let filename = String(video.filename || '');
  let basename = path.basename(filename, path.extname(filename));
  let parent = path.basename(path.dirname(filename));
  let explicitYear = validYear(video.year);
  let all = [];

  let titleWasEdited = typeof video.title === 'string' && video.title.trim() &&
    video.title.trim() !== basename.trim();
  let filenameStructuralMarker = strongStructuralMarker(basename);

  // A file in an Extras/Featurettes/Subtitles folder is far more likely to
  // share a generic interview or trailer name with an unrelated IMDb record
  // than to have its own reliable movie entry. Leave it for manual tagging.
  // An explicitly edited title still opts back into the normal search path.
  if (!titleWasEdited && (parentLooksAuxiliary(parent) ||
      basenameLooksLikeSampleOrGarbage(filename))) return [];
  let fromEditedTitle = titleWasEdited ?
    deriveCandidates(video.title, 'video title', explicitYear) : [];
  let fromFilename = deriveCandidates(basename || video.title, 'filename', explicitYear);
  // If the filename explicitly says it is an episode/miniseries part, a plain
  // containing folder must not reintroduce the bare franchise title that the
  // filename parser intentionally refused to create. A deliberate title edit
  // remains an explicit user opt-in to ordinary movie matching.
  let fromParent = (!titleWasEdited && filenameStructuralMarker) ||
    isGenericParent(parent) || parentLooksLikeCollection(parent) ? [] :
    deriveCandidates(parent, 'parent folder', explicitYear);

  // An unnumbered folder such as "Franchise - Subtitle" can contribute the
  // shorter trailing title after the complete filename query fails. If that
  // filename independently supplied a release year and the trailing title is
  // a substantial part of it, keep the same year on this one fallback. Losing
  // it here can let an older same-named movie outrank the intended canonical
  // franchise title ("No Way Home" is the real-world example).
  let filenameYearCandidate = fromFilename.find(candidate => candidate.year);
  if (!titleWasEdited && filenameYearCandidate) {
    fromParent = fromParent.map(candidate => {
      let inheritsFilenameYear = !candidate.year && candidate.reason === 'after dash prefix' &&
        titleKey(candidate.title).length < titleKey(filenameYearCandidate.title).length &&
        canonicalTitleMatches(filenameYearCandidate.title, candidate.title);
      return inheritsFilenameYear ?
        Object.assign({}, candidate, {year: filenameYearCandidate.year}) : candidate;
    });
  }

  let cleanParent = fromParent.length > 0 &&
    !/(?:www\.|\.com\b|\.org\b|torrent|rartv|tgx)/i.test(parent);
  let parentHasYear = Boolean(fromParent[0] && fromParent[0].year);
  let filenameHasYear = Boolean(fromFilename[0] && fromFilename[0].year);
  let parentFilenameYearsConflict = parentHasYear && filenameHasYear &&
    fromParent[0].year !== fromFilename[0].year;
  let preferParent = cleanParent && (parentHasYear || candidateLooksOpaque(fromFilename[0])) &&
    (!filenameHasYear || parentHasYear) && !parentFilenameYearsConflict;

  if (fromEditedTitle.length > 0) all.push(...fromEditedTitle);
  all.push(...(preferParent ? fromParent : fromFilename));
  all.push(...(preferParent ? fromFilename : fromParent));

  // Avoid making two equivalent requests merely because one source omitted a
  // year. Prefer the first candidate, except that a later known year enriches
  // an otherwise identical title.
  let deduplicated = [];
  for (let candidate of all) {
    let key = titleKey(candidate.title);
    let existingIndex = deduplicated.findIndex(item => titleKey(item.title) === key);
    if (existingIndex < 0) {
      deduplicated.push(candidate);
    } else if (!deduplicated[existingIndex].year && candidate.year) {
      deduplicated[existingIndex] = candidate;
    }
  }
  return deduplicated;
}

function omdbTypeForKind(kind) {
  return {movie: 'movie', show: 'episode', episode: 'episode', series: 'series'}[kind] || '';
}

function typeIsCompatible(result, video) {
  let expected = omdbTypeForKind(video && (video.kind || video.type));
  if (expected) return result.Type === expected;

  // A custom Mynda kind must survive tagging. Such a video can still consume
  // ordinary movie or episode metadata, but a series record is not a playable
  // video and is therefore never auto-selected.
  return result.Type === 'movie' || result.Type === 'episode';
}

function titleMatchKind(candidateTitle, resultTitle, options = {}) {
  if (titleKey(candidateTitle) === titleKey(resultTitle)) return 'exact';
  if (titleKeyWithoutArticle(candidateTitle) === titleKeyWithoutArticle(resultTitle)) return 'article';
  if (options.allowCanonicalTitle && canonicalTitleMatches(candidateTitle, resultTitle)) return 'canonical';
  return '';
}

function scoreResult(result, candidate, video, options = {}) {
  let matchKind = titleMatchKind(candidate.title, result.Title, options);
  let candidateYear = validYear(candidate.year);
  let resultYear = firstResultYear(result.Year);
  let yearDifference = candidateYear && resultYear ?
    Math.abs(Number(candidateYear) - Number(resultYear)) : null;
  let compatibleType = typeIsCompatible(result, video);
  let score = matchKind === 'exact' ? 100 : matchKind === 'article' ? 90 :
    matchKind === 'canonical' ? 70 : 0;
  if (candidateYear && resultYear) {
    score += yearDifference === 0 ? 25 : yearDifference === 1 ? 12 : -40;
  }
  if (compatibleType) score += 5;
  return {
    result: result,
    score: score,
    matchKind: matchKind,
    candidateYear: candidateYear,
    resultYear: resultYear,
    yearDifference: yearDifference,
    compatibleType: compatibleType
  };
}

// Separates lightweight search rows that are strong enough to justify fetching
// full records. Exact normalized titles outrank leading-article equivalents,
// which in turn outrank explicitly enabled canonical expansions. A known year
// must normally agree; an explicit relaxed path may permit a bounded regional
// discrepancy. The full record must still pass runtime/vote validation in
// OmdbHelper before unattended Auto-Tag can apply it.
function evaluateSearchResults(results, candidate, video, options = {}) {
  let ranked = (Array.isArray(results) ? results : [])
    .filter(result => result && result.imdbID && result.Title && typeIsCompatible(result, video))
    .map(result => scoreResult(result, candidate, video, options))
    .sort((left, right) => right.score - left.score);

  let acceptable = ranked.filter(item => {
    if (!item.matchKind) return false;
    // Without a year, require one unique normalized-title match rather than
    // requiring OMDb's entire result list to contain only one movie. The caller
    // still retrieves and validates the full record (runtime and vote evidence)
    // before Auto-Tag may apply it.
    if (!item.candidateYear) return true;
    if (!item.resultYear) return false;
    return item.yearDifference === 0 ||
      (options.allowAdjacentYear && item.yearDifference === 1) ||
      (options.allowDistantYear && item.matchKind === 'exact' &&
        item.yearDifference >= 2 &&
        item.yearDifference <= (Number(options.maxYearDifference) || 3));
  });

  // Keep each confidence tier separate. Previously, a single exact title plus
  // several merely canonical expansions could push the combined group over the
  // detail-probe cap and hide the exact result. Exact punctuation-insensitive
  // matches now win first, article-only equivalents second, and canonical
  // expansions only when neither stronger tier produced a candidate.
  let exact = acceptable.filter(item => item.matchKind === 'exact');
  let article = acceptable.filter(item => item.matchKind === 'article');
  let canonical = acceptable.filter(item => item.matchKind === 'canonical');
  let strongest = exact.length > 0 ? exact : article.length > 0 ? article : canonical;

  // Two records with the same validating evidence are a real ambiguity, even
  // if their posters or IMDb ordering differ. Hand both to the editor instead.
  let confident = strongest.length === 1 ? strongest[0].result : null;
  return {
    confident: confident,
    rankedResults: ranked.map(item => item.result),
    acceptableResults: strongest.map(item => item.result),
    allAcceptableResults: acceptable.map(item => item.result),
    exactResults: exact.map(item => item.result),
    articleResults: article.map(item => item.result),
    canonicalResults: canonical.map(item => item.result)
  };
}

function parseRuntimeMinutes(value) {
  let runtime = String(value || '').trim();
  if (!runtime || runtime.toUpperCase() === 'N/A') return null;

  let hours = runtime.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  let minutes = runtime.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (hours || minutes) {
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  }

  let numberOnly = runtime.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return numberOnly ? Number(numberOnly[1]) : null;
}

function localDurationMinutes(video) {
  let seconds = Number(video && video.metadata && video.metadata.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
}

function parseImdbVotes(value) {
  let normalized = String(value || '').replace(/,/g, '').trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

// Full OMDb records contain evidence that the lightweight search list lacks.
// Use it as a veto against obviously impossible matches, not as a demand that
// every edition have precisely the canonical runtime. The deliberately large
// tolerance preserves extended/director cuts while rejecting a short, trailer,
// sample, or compilation record for a feature-length local file.
function evaluateFullResultPlausibility(result, video, options = {}) {
  let localMinutes = localDurationMinutes(video);
  let omdbMinutes = parseRuntimeMinutes(result && result.Runtime);
  let imdbVotes = parseImdbVotes(result && result.imdbVotes);
  let splitFile = isSplitFile(video);
  let reasons = [];

  if (localMinutes && localMinutes > 60 && /\bShort\b/i.test(String(result && result.Genre || ''))) {
    reasons.push('OMDb classifies the result as a short, but the local video is feature-length');
  }

  if (localMinutes && omdbMinutes) {
    let difference = Math.abs(localMinutes - omdbMinutes);
    let ratio = Math.max(localMinutes, omdbMinutes) / Math.min(localMinutes, omdbMinutes);
    let plausibleSplitPart = splitFile && localMinutes < omdbMinutes;
    if (difference > 45 && ratio > 1.5 && !plausibleSplitPart) {
      reasons.push(`Local and OMDb runtimes differ implausibly (${Math.round(localMinutes)} vs ${Math.round(omdbMinutes)} minutes)`);
    }

    // Canonical-title expansions and two/three-year corrections are useful
    // discovery aids, but neither is safe enough to rely on the normal broad
    // edition tolerance. They require a close runtime match. Split-file
    // exceptions never use this path because one part cannot closely match the
    // catalog's combined runtime.
    if (options.requireTightRuntime) {
      let tightTolerance = Math.max(8, omdbMinutes * 0.1);
      if (difference > tightTolerance) {
        reasons.push(`A relaxed title/year match needs a close runtime (${Math.round(localMinutes)} vs ${Math.round(omdbMinutes)} minutes)`);
      }
    }
  } else if (options.requireTightRuntime) {
    reasons.push('A relaxed title/year match needs comparable local and OMDb runtimes');
  }

  // A yearless title such as "Se7en", or an exact title with a two/three-year
  // discrepancy, can expose an obscure duplicate. Auto-select such a result
  // only when the runtimes can be compared and the record has enough audience
  // history to be trustworthy.
  if (options.requireStrongEvidence) {
    if (!localMinutes || !omdbMinutes) {
      reasons.push('A relaxed match needs comparable local and OMDb runtimes');
    }
    let minimumVotes = Number(options.minimumImdbVotes) || 1000;
    if (!imdbVotes || imdbVotes < minimumVotes) {
      reasons.push(`A relaxed match needs at least ${minimumVotes} IMDb votes`);
    }
  }

  return {
    plausible: reasons.length === 0,
    reasons: reasons,
    localRuntimeMinutes: localMinutes,
    omdbRuntimeMinutes: omdbMinutes,
    imdbVotes: imdbVotes,
    splitFile: splitFile
  };
}

function evaluateFullResult(result, candidate, video, options = {}) {
  let titleYearEvaluation = evaluateSearchResults([result], candidate, video, options);
  let titleYearConfident = titleYearEvaluation.confident === result;
  let scored = scoreResult(result, candidate, video, options);
  let plausibilityOptions = Object.assign({}, options);

  // A catalog-title expansion is accepted only when runtime evidence is much
  // tighter than the ordinary allowance for alternate cuts/editions.
  let splitPartLabelMatch = isSplitFile(video) &&
    titlesDifferOnlyByPartLabel(candidate.title, result && result.Title);
  if (scored.matchKind === 'canonical' && !splitPartLabelMatch) {
    plausibilityOptions.requireTightRuntime = true;
    if (!scored.candidateYear) plausibilityOptions.requireStrongEvidence = true;
  }

  // OMDb sometimes reports a regional/catalog release year two or three years
  // after the year embedded in the local release. This path is intentionally
  // narrower than the existing one-year retry: exact normalized title, close
  // runtime, and a well-established IMDb record are all mandatory.
  if (scored.yearDifference !== null && scored.yearDifference >= 2) {
    plausibilityOptions.requireTightRuntime = true;
    plausibilityOptions.requireStrongEvidence = true;
  }

  let plausibility = evaluateFullResultPlausibility(result, video, plausibilityOptions);
  let reasons = plausibility.reasons.slice();
  if (!titleYearConfident) {
    reasons.unshift('OMDb title/year did not uniquely match the search candidate');
  }
  return {
    confident: titleYearConfident && plausibility.plausible,
    titleYearConfident: titleYearConfident,
    matchKind: scored.matchKind,
    yearDifference: scored.yearDifference,
    plausibility: plausibility,
    reasons: reasons
  };
}

function fullResultIsConfident(result, candidate, video, options = {}) {
  return evaluateFullResult(result, candidate, video, options).confident;
}

module.exports = {
  basenameLooksLikeSampleOrGarbage,
  buildNormalizedDiscoveryQueries,
  buildSearchCandidates,
  buildTitleQueryVariants,
  canonicalTitleMatches,
  evaluateFullResult,
  evaluateFullResultPlausibility,
  evaluateSearchResults,
  fullResultIsConfident,
  isSplitFile,
  omdbTypeForKind,
  parseRuntimeMinutes,
  pathContainsSampleArea,
  titleKey,
  validYear
};
