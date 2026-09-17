// Pure interpretation of series labels and episode identifiers.

const EpisodeMatch = require('./EpisodeMatch');
const {seriesIdentityKey:comparableSeriesTitle,editDistance,fold,leadingArticle} = require('./TitleNormalization');
const {predictableFailure, normalizeEpisodeNumber} = require('./CatalogResponse');
function extractSeriesSearchParts(series) {
  let title = series.trim();
  let year = null;

  // A year attached to the series name can distinguish two series with the
  // same title. It is a series year, unlike video.year, which is normally the
  // air year of one episode and is deliberately ignored here.
  let yearMatch = title.match(/\s*[\[(]((?:19|20)\d{2})(?:\s*-\s*(?:19|20)\d{2})?[\])]\s*$/);
  if (yearMatch) {
    year = yearMatch[1];
    title = title.slice(0, yearMatch.index).trim();
  }

  // Normalize a few common folder-name conventions without changing the
  // series value stored in the library.
  title = leadingArticle(title);
  title = title.replace(/\s+-\s+\d{1,2}\s+-\s+/g, ' ');
  title = title.replace(/\s*\((?:BBC|ITV)\)\s*$/i, '');
  title = title.replace(/\s{2,}/g, ' ').trim();

  return {title: title, year: year};
}

function extractSeriesFolderYear(filename, seriesTitle) {
  let expectedTitle = comparableSeriesTitle(seriesTitle);
  if (!expectedTitle || typeof filename !== 'string' || !filename.trim()) {
    return null;
  }

  // Split on both separators so this works with libraries created on either
  // macOS or Windows, regardless of the OS currently running Mynda.
  let folders = filename.split(/[\\/]+/).slice(0, -1).reverse();
  for (let folder of folders) {
    let yearMatch = folder.match(
      /(?:^|[\s.(\[_-])((?:19|20)\d{2})(?:\s*[-–—]\s*(?:19|20)\d{2})?(?=$|[\s.)\]_-])/
    );
    if (!yearMatch) {
      continue;
    }

    let titleBeforeYear = folder.slice(0, yearMatch.index).trim();
    // A numbered series collection can retain its complete season range
    // before the premiere year: Doctor Who 01 S01-S04 (1963- ...).
    titleBeforeYear = titleBeforeYear.replace(/\s+\d{1,2}\s+S\d{1,2}\s*[-–—]\s*S?\d{1,2}\s*\(?\s*$/i, '');
    if (comparableSeriesTitle(titleBeforeYear) === expectedTitle) {
      return yearMatch[1];
    }
  }
  return null;
}

function seriesSearchPartsForVideo(video) {
  let series = video && typeof video.series === 'string' ? video.series.trim() : '';
  let searchParts = extractSeriesSearchParts(series);
  searchParts.yearSource = searchParts.year ? 'series field' : null;
  if (!searchParts.year) {
    searchParts.year = extractSeriesFolderYear(video && video.filename, searchParts.title);
    if (searchParts.year) {
      searchParts.yearSource = 'series folder';
    }
  }
  // Miniseries releases sometimes attach the premiere year to the series in a
  // placeholder with an episode-only designator (Roots.1977...EP1). Retain it
  // during the inferred-season lookup too, but never borrow video.year or a
  // year from a titled episode / an ordinary SxxExx release.
  if (!searchParts.year && video) {
    const release = require('./EpisodeTitleEvidence.js').releaseTitleInfo(video.title, series);
    if (release && release.seriesYear && /^(?:episode|ep|e)[\s._-]*\d/i.test(release.marker)) {
      searchParts.year = release.seriesYear;
      searchParts.yearSource = 'unnumbered series release title';
    }
  }
  return searchParts;
}

function andAmpersandTitleAlternates(title) {
  let original = String(title || '').trim();
  let alternatives = [];
  const addAlternative = value => {
    value = value.replace(/\s{2,}/g, ' ').trim();
    if (value && value !== original && !alternatives.includes(value)) {
      alternatives.push(value);
    }
  };

  if (/\band\b/i.test(original)) {
    addAlternative(original.replace(/\band\b/gi, '&'));
  }
  if (/&/.test(original)) {
    addAlternative(original.replace(/\s*&\s*/g, ' and '));
  }
  return alternatives;
}

function terminalAcronymSearchPrefix(title) {
  let original = String(title || '').trim();
  let match = original.match(/^(.+?)\s+([A-Z0-9]{2,6})$/);
  if (!match || !/[A-Z]/.test(match[2])) {
    return null;
  }
  return {
    title: match[1].trim(),
    acronym: match[2]
  };
}

function seriesCacheKey(searchParts, video) {
  const directory = String(video && video.filename || '').split(/[\\/]+/).slice(0,-1).join('/');
  return JSON.stringify([comparableSeriesTitle(searchParts.title),searchParts.year || '',directory]);
}

function seriesTitleWords(title) {
  let value = fold(title);
  value = leadingArticle(value);
  value = value.replace(/&/g, ' and ').replace(/\bdr\.?\b/gi, 'Doctor');
  let words = value.match(/[a-z0-9]+/gi) || [];
  if (/^(?:the|an|a)$/i.test(words[0])) {
    words.shift();
  }
  return words;
}

function seriesAcronymMatches(requestedTitle, resultTitle) {
  let requestedWords = seriesTitleWords(requestedTitle);
  let resultWords = seriesTitleWords(resultTitle);
  if (requestedWords.length === 0 || resultWords.length === 0) {
    return false;
  }

  let mismatch = 0;
  while (mismatch < requestedWords.length-1 && mismatch < resultWords.length &&
         requestedWords[mismatch].toLowerCase() === resultWords[mismatch].toLowerCase()) {
    mismatch++;
  }

  let acronym = requestedWords[mismatch];
  if (mismatch !== requestedWords.length-1 || !/^(?=.*[A-Z])[A-Z0-9]{2,6}$/.test(acronym || '')) {
    return false;
  }

  const numberInitials = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10'
  };
  let expandedInitials = resultWords.slice(mismatch).map(word => {
    let lowerWord = word.toLowerCase();
    if (numberInitials[lowerWord]) {
      return numberInitials[lowerWord];
    }
    if (/^\d000$/.test(lowerWord)) {
      return `${lowerWord[0]}k`;
    }
    return lowerWord[0];
  }).join('');

  return acronym.toLowerCase() === expandedInitials;
}

function seriesTitlesMatch(requestedTitle, resultTitle, allowContainedTitle) {
  let requested = comparableSeriesTitle(requestedTitle);
  let result = comparableSeriesTitle(resultTitle);
  if (!requested || !result) {
    return false;
  }
  if (requested === result) {
    return true;
  }
  if (seriesAcronymMatches(requestedTitle, resultTitle)) {
    return true;
  }

  let longer = requested.length >= result.length ? requested : result;
  let shorter = requested.length < result.length ? requested : result;
  if (allowContainedTitle && shorter.length >= 6 && longer.includes(shorter) && shorter.length/longer.length >= 0.35) {
    return true;
  }

  // Permit a small spelling discrepancy, but only for substantial titles.
  let allowedEdits = longer.length >= 14 ? 2 : (longer.length >= 7 ? 1 : 0);
  return allowedEdits > 0 && editDistance(requested, result) <= allowedEdits;
}

function localEpisodeTitleForVerification(video) {
  return EpisodeMatch.usefulEpisodeTitle(video && video.title, video && video.series, {dvd:Boolean(video && video.dvd)});
}

function seriesYearMatches(requestedYear, resultYear) {
  return !requestedYear || String(resultYear || '').startsWith(requestedYear);
}

function matchingSeriesResults(requestedTitle, requestedYear, results) {
  let eligible = (Array.isArray(results) ? results : []).filter(result => {
    return result && result.Type === 'series' && result.imdbID &&
      seriesYearMatches(requestedYear, result.Year);
  });

  let exact = eligible.filter(result => {
    return comparableSeriesTitle(requestedTitle) === comparableSeriesTitle(result.Title);
  });
  if (exact.length > 0) {
    return {matchStrength: 'exact', candidates: exact};
  }

  let acronym = eligible.filter(result => seriesAcronymMatches(requestedTitle, result.Title));
  if (acronym.length > 0) {
    return {matchStrength: 'acronym', candidates: acronym};
  }

  let fuzzy = eligible.filter(result => seriesTitlesMatch(requestedTitle, result.Title, true));
  return {matchStrength: 'fuzzy', candidates: fuzzy};
}

function makeSeriesChoice(result) {
  return {
    Poster: result.Poster,
    Title: result.Title,
    Type: 'series',
    Year: result.Year,
    imdbID: result.imdbID,
    myndaChoiceType: 'series'
  };
}

function ambiguousSeriesFailure(series, candidates) {
  let failure = predictableFailure(
    'Ambiguous series',
    `More than one OMDb series matches "${series}"`
  );
  failure.choiceType = 'series';
  failure.choices = candidates.map(makeSeriesChoice);
  return failure;
}

function canInferSingleSeason(video) {
  return Boolean(video && video.kind === 'show' && !video.dvd &&
    typeof video.series === 'string' && video.series.trim() &&
    String(video.season == null ? '' : video.season).trim() === '' &&
    normalizeEpisodeNumber(video.episode) > 0);
}

module.exports = {extractSeriesSearchParts, extractSeriesFolderYear, seriesSearchPartsForVideo, andAmpersandTitleAlternates, terminalAcronymSearchPrefix, comparableSeriesTitle, seriesCacheKey, seriesTitleWords, seriesAcronymMatches, editDistance, seriesTitlesMatch, localEpisodeTitleForVerification, seriesYearMatches, matchingSeriesResults, makeSeriesChoice, ambiguousSeriesFailure, canInferSingleSeason};
