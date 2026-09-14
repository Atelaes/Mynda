// Filename/folder interpretation belongs to scanning and explicit Reset from Filename.
// Auto-Tag consumes the resulting editable tags and never calls this module.
function titleCaseDetectedTitle(title) {
  // Preserve intentional capitalization in mixed-case titles and acronyms.
  // The filenames that need correction are the ones whose letters are all
  // lowercase; exact-basename fallbacks never reach this function.
  if (!/[a-z]/.test(title) || /[A-Z]/.test(title)) {
    return title;
  }

  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
    'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'so', 'the', 'to', 'up',
    'via', 'vs', 'with', 'yet'
  ]);
  const uppercaseWords = new Set(['ac3', 'dvd', 'er', 'fs', 'sfm', 'ws']);
  const romanNumerals = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/;
  const wordRegex = /[a-z][a-z0-9]*(?:['’][a-z0-9]+)*/g;
  const words = title.match(wordRegex) || [];
  let wordIndex = 0;

  return title.replace(wordRegex, (word, offset) => {
    const isFirst = wordIndex === 0;
    const isLast = wordIndex === words.length-1;
    wordIndex++;

    const previousCharacter = title[offset-1];
    const nextCharacter = title[offset+word.length];
    const isDottedInitial = word.length === 1 &&
      (previousCharacter === '.' || nextCharacter === '.');
    const beginsSubtitle = /(?:[:–—]|(?:^|\s)-)\s*$/.test(title.slice(0, offset));

    if (isDottedInitial || romanNumerals.test(word) || uppercaseWords.has(word)) {
      return word.toUpperCase();
    }
    if (!isFirst && !isLast && !beginsSubtitle && minorWords.has(word)) {
      return word;
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function findEpisodeTitle(fileBasename, extrasDetected) {
  const fallback = fileBasename;
  const titleMarkers = [
    // S02E03, including multi-part forms such as S02E03-E04,
    // S02E03&E04, S02E03&04, or S02E03X02.
    /(?:^|[^a-z0-9])s\d{1,3}[. _-]*e[. _-]*\d{1,3}(?:(?:[. _-]*e[. _-]*\d{1,3})|(?:&[. _-]*e?[. _-]*\d{1,3})|(?:x\d{1,2}))*(?!\d)/i,
    // Season 2 Episode 3.
    /season[. _-]*\d{1,3}[. _-]*(?:episode|ep|e)[. _-]*\d{1,3}(?:-\d{1,3})?(?!\d)/i,
    // 2x03.
    /(?:^|[^\d])\d{1,2}[ _-]*x[ _-]*\d{1,2}(?:-\d{1,2})?(?!\d)/i,
    // 02.03 at the beginning, but not a title or date such as 11.22.63.
    /^\d{1,2}\.\d{1,3}(?![.\d])/,
    // A compact code such as 203 when followed by a title separator.
    /(?:^|-\s*)[1-9]\d{2}(?=\s*-\s)/,
    // Episode 3, Ep03, or E03.
    /(?:^|[^a-z0-9])(?:episode|ep|e)[. _-]*\d{1,3}(?:-\d{1,3})?(?!\d)/i
  ];

  if (extrasDetected) {
    // Strong extras formats found in the real TV folder inventory.
    titleMarkers.push(
      /(?:^|[^a-z0-9])extras?[. _-]+season[. _-]*\d{1,3}(?!\d)/i,
      /season[. _-]*\d{1,3}[. _-]+extras?[. _-]*\d{1,3}(?!\d)/i
    );
  }

  // A leading episode number followed by a clear title separator.
  titleMarkers.push(/^\d{1,4}(?!\d)(?:\s*[-–—]\s+|[._](?!\d))/);

  let marker = null;
  for (let regex of titleMarkers) {
    marker = fileBasename.match(regex);
    if (marker) {
      break;
    }
  }
  if (!marker) {
    return fallback;
  }

  let title = fileBasename.slice(marker.index + marker[0].length);
  title = title.replace(/^[\s_\-\]\)–—]+/, '');
  // A single dot is commonly a filename separator. Preserve an ellipsis or a
  // leading decimal that may genuinely be part of the title.
  if (/^\.(?=[a-z])/i.test(title)) {
    title = title.slice(1).replace(/^\s+/, '');
  }

  const hasReleaseDetails = value => {
    return /(?:^|[\s._-])(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|(?:bd|br|dvd)[ ._-]?rip|hdtv|remux|repack|proper|[hx][ ._-]?26[45]|hevc|xvid|10[ ._-]?bit|aac|ac3|eac3|ddp)(?![a-z0-9])/i.test(value);
  };

  // Remove trailing bracketed groups only when they contain unmistakable
  // technical details. Keep title details such as "(1)" or "(1948)".
  let previousTitle;
  do {
    previousTitle = title;
    title = title.replace(/\s*(?:\(([^()]*)\)|\[([^\[\]]*)\])\s*$/, (whole, parenContents, bracketContents) => {
      return hasReleaseDetails(parenContents || bracketContents) ? '' : whole;
    });
  } while (title !== previousTitle);

  // This exact suffix occurs in the 11.22.63 release and is clearly not part
  // of any episode title.
  title = title.replace(/\s+-\s+mini[ -]?series\b.*$/i, '');

  // Stop at the first unbracketed technical release marker. Deliberately do
  // not strip generic years, words, or parenthetical text.
  let releaseMatch = title.match(/(?:^|[\s._\[(,\-])(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|(?:bd|br|dvd)[ ._-]?rip|hdtv|remux|repack|proper|[hx][ ._-]?26[45]|hevc|xvid|10[ ._-]?bit)(?![a-z0-9])/i);
  if (releaseMatch) {
    title = title.slice(0, releaseMatch.index);
  }

  title = title.replace(/_/g, ' ').trim();

  // Release-formatted titles often use dots as spaces. Only replace them when
  // the candidate contains no real spaces, while preserving ellipses, dotted
  // initials such as M.I.A., and dotted-number titles such as 11.22.63.
  const isDottedInitialism = /^(?:[a-z]\.){2,}(?:[a-z]\.?)?$/i.test(title);
  const isDottedNumber = /^\d+(?:\.\d+){2,}$/.test(title);
  if (!/\s/.test(title) && title.includes('.') && !isDottedInitialism && !isDottedNumber) {
    let protectedDots = [];
    title = title.replace(/\.{2,}/g, dots => {
      protectedDots.push(dots);
      return `\u0000${protectedDots.length-1}\u0000`;
    });
    title = title.replace(/\./g, ' ');
    title = title.replace(/\u0000(\d+)\u0000/g, (whole, index) => protectedDots[Number(index)]);
  }

  title = title.replace(/\s{2,}/g, ' ').replace(/^[\s_\-\]\)–—]+|[\s_\-–—]+$/g, '');

  // If the marker had no title after it, or only a short release label was
  // left, retain the complete basename instead of guessing.
  if (!/[a-z0-9]/i.test(title) || /^(?:fs|dsr|ws|multi|web|repack|proper)$/i.test(title)) {
    return fallback;
  }
  return titleCaseDetectedTitle(title);
}

// Find the most specific watchfolder containing a video's current path. The
// longest match matters when users configure nested watchfolders. path.relative
// avoids false positives such as treating "/Movies 2" as part of "/Movies".
function findContainingWatchfolder(filename, watchfolders = library.settings.watchfolders) {
  if (typeof filename !== 'string' || filename === '' || !Array.isArray(watchfolders)) {
    return null;
  }

  return watchfolders
    .filter(watchfolder => {
      if (!watchfolder || typeof watchfolder.path !== 'string' || watchfolder.path === '') {
        return false;
      }
      const relativePath = path.relative(path.resolve(watchfolder.path), path.resolve(filename));
      return relativePath === '' ||
        (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
    })
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0] || null;
}

function findSeasonEpisode(video, fileBasename) {
  const normalizeNumber = value => value.replace(/^0+(?=\d)/, '');
  let seRegexes = [
    // S02E03, S02-E03, S02 E03, etc.
    /(?:^|[^a-z0-9])s(\d{1,3})[. _-]*e[. _-]*(\d{1,3})(?!\d)/i,
    // Season 2 Episode 3, Season_2_Ep_3, etc.
    /season[. _-]*(\d{1,3})[. _-]*(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i,
    // 2x03, 2 X 03, etc. Limit both numbers to two digits so codecs such as x264 are ignored.
    /(?:^|[^\d])(\d{1,2})[ _-]*x[ _-]*(\d{1,2})(?!\d)/i,
    // 02.03 at the beginning of a filename, but not a date such as 11.22.63.
    /^(\d{1,2})\.(\d{1,3})(?![.\d])/,
    // 203 surrounded by separators means season 2, episode 03.
    /(?:^|-\s*)([1-9])(\d{2})(?=\s*-\s)/
  ];
  let eRegexes = [/(?:^|[^a-z0-9])(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i];
  let seasonRegexes = [
    /season[. _-]*(\d{1,3})(?!\d)/i,
    /(?:^|[^a-z0-9])s(\d{1,3})(?!\d)/i,
    /(\d{1,3})(?:st|nd|rd|th)[. _-]*season/i
  ];
  let result = {};

  function findSeasonNumber(value) {
    // A range describes several seasons, so it cannot provide one season number.
    if (/season[. _-]*\d{1,3}\s*(?:-\s*|to\s+)\d{1,3}/i.test(value) ||
        /(?:^|[^a-z0-9])s\d{1,3}\s*-\s*s?\d{1,3}(?!\d)/i.test(value)) {
      return null;
    }
    for (let regex of seasonRegexes) {
      let match = value.match(regex);
      if (match) {
        return normalizeNumber(match[1]);
      }
    }
    return null;
  }

  function cleanSeriesName(folderName) {
    let name = folderName.trim();
    const originalName = name;
    let releaseDetailsRemoved = false;

    // A release folder such as "11.22.63 - Stephen King 8 Part Mini Series..."
    // normally puts the actual title before the first separator.
    let miniSeriesMatch = name.match(/^(.+?)\s+-\s+.*\b(?:mini[ -]?series|miniseries)\b.*$/i);
    if (miniSeriesMatch) {
      name = miniSeriesMatch[1];
      releaseDetailsRemoved = true;
    }

    // Remove only explicit release markers. Avoid generic removal of years,
    // resolutions, or punctuation that could legitimately be part of a title.
    let releaseSuffixes = [
      /[\s._-]*(?:\(|\[)?complete(?:[ ._-]+original)?(?:[ ._-]+tv)?[ ._-]+series\b.*$/i,
      /[\s._-]+(?:complete[\s._-]+)?seasons?[\s._-]*\d{1,3}(?!\d).*$/i,
      /[\s._-]+s\d{1,3}(?!\d)(?:\s*-\s*s?\d{1,3})?\b.*$/i,
      /\s+BD\s*\(\d{3,4}x\d{3,4}\).*$/i
    ];
    for (let regex of releaseSuffixes) {
      let cleanedName = name.replace(regex, '');
      if (cleanedName !== name) {
        name = cleanedName;
        releaseDetailsRemoved = true;
      }
    }

    // Remove release-year ranges. A single trailing year is removed only when
    // another explicit release marker has already established that it is metadata.
    name = name.replace(/\s*[\[(](?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}[\])]\s*$/, '');
    name = name.replace(/[\s._-]+(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}\s*$/, '');
    if (releaseDetailsRemoved) {
      name = name.replace(/[\s._-]+(?:19|20)\d{2}\s*$/, '');
    }

    // Dot/underscore replacement is limited to clearly release-formatted names,
    // so a title such as "11.22.63" keeps its punctuation.
    if (/\.(?:season|s\d{1,3}|complete)(?:\.|$)/i.test(originalName)) {
      name = name.replace(/[._]+/g, ' ');
    }

    name = name.replace(/^[\s._-]+|[\s._-]+$/g, '').replace(/\s{2,}/g, ' ');
    return name || folderName.trim();
  }

  function normalizeCategoryName(value) {
    return value.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  function isExtrasFolderName(folderName) {
    const name = normalizeCategoryName(folderName);

    // Mixed release folders such as "Season 1 + Extras" are only a weak
    // signal. A strong SxxEyy-style filename below will still take priority.
    if (/(?:\+|&|\band\b)\s*extras?\b/.test(name)) {
      return true;
    }

    // Match category-like folder names and suffixes, but do not treat a
    // generic occurrence of words such as "special" as an extras marker.
    return /(?:^| )(?:extras?|featurettes?|special features?|specials|bonus(?: features?| material| content| disc)?|deleted scenes?|behind the scenes|making of|bloopers?|gag reels?|supplements?|interviews?|trailers?)$/.test(name);
  }

  function isExtrasFilename(filename) {
    const name = normalizeCategoryName(filename);

    // Filename detection is intentionally narrower than folder detection.
    // These phrases are strong evidence for bonus material; ordinary uses of
    // "special", "interview", or "trailer" are left alone.
    return /(?:^| )(?:featurettes?|special features?|bonus(?: features?| material| content)|deleted scenes?|behind the scenes|making of|bloopers?|gag reels?|supplements?)(?: |$)/.test(name) ||
      /^extras?(?: \d{1,3})?(?: |$)/.test(name) ||
      /(?:^| )dvd extras?(?: |$)/.test(name);
  }

  let extrasDetected = false;
  let dedicatedExtrasFolder = false;

  if (Array.isArray(video.folderParts) && video.folderParts.length > 0) {
    const folders = video.folderParts;
    // The first folder beneath a show watchfolder is its most reliable series
    // grouping, even when files are directly inside it or nested under Extras.
    result.series = cleanSeriesName(folders[0]);

    // The first folder is the series name, so only examine folders beneath it
    // for an extras category. This avoids misclassifying a show actually named
    // "Extras" or "Specials".
    extrasDetected = folders.slice(1).some(isExtrasFolderName);
    dedicatedExtrasFolder = folders.slice(1).some(folder =>
      isExtrasFolderName(folder) && findSeasonNumber(folder) === null);

    // Use the closest folder that describes one specific season. This also
    // works when the video is inside an Extras or Episodes subfolder.
    for (let i=folders.length-1; i>=0; i--) {
      let folderSeason = findSeasonNumber(folders[i]);
      if (folderSeason !== null) {
        result.season = folderSeason;
        break;
      }
    }
  }
  if (!extrasDetected) {
    extrasDetected = isExtrasFilename(fileBasename);
  }
  result.title = findEpisodeTitle(fileBasename, extrasDetected);

  // A dedicated Extras folder can contain its own numbered shorts. Do not
  // interpret "Shorts & Extras/02.01 - ..." as ordinary season two. Mixed
  // "Season 1 + Extras" folders and explicit season-zero specials still work.
  for (let i=0; i<seRegexes.length; i++) {
    let regex  = seRegexes[i];
    let match = fileBasename.match(regex);
    if (match) {
      result.season = normalizeNumber(match[1]);
      result.episode = normalizeNumber(match[2]);
      if (dedicatedExtrasFolder && result.season !== '0') result.season = 'extras';
      //console.log(`seasonEpisode result for ${fileBasename} is ${JSON.stringify(result)}`);
      return result;
    }
  }

  // When no explicit season/episode pair was found, an extras category takes
  // priority over a numbered season inherited from a parent release folder.
  if (extrasDetected) {
    result.season = 'extras';
  }

  // This primarily covers DVD-rip folders whose own name contains the season.
  if (!result.season) {
    let basenameSeason = findSeasonNumber(fileBasename);
    if (basenameSeason !== null) {
      result.season = basenameSeason;
    }
  }

  for (let j=0; j<eRegexes.length; j++) {
    let regex  = eRegexes[j];
    let match = fileBasename.match(regex);
    if (match) {
      result.episode = normalizeNumber(match[1]);
      return result;
    }
  }

  // A number at the beginning followed by a title separator is an episode
  // number. If it is a compact season/episode code (201, 801, etc.), use the
  // season found in the folder to separate the two numbers.
  let leadingMatch = fileBasename.match(/^(\d{1,4})(?!\d)(?:\s*[-–—]\s+|[._](?!\d))/);
  if (leadingMatch) {
    let leadingNumber = leadingMatch[1];
    let episode = leadingNumber;
    if (result.season && leadingNumber.startsWith(result.season) &&
        leadingNumber.length-result.season.length === 2) {
      episode = leadingNumber.slice(result.season.length);
    } else if (leadingNumber.length > 3) {
      return result;
    }
    result.episode = normalizeNumber(episode);
  }
  //console.log(`seasonEpisode result for ${fileBasename} is ${JSON.stringify(result)}`);
  return result;
}

module.exports = {findEpisodeTitle, findSeasonEpisode};
