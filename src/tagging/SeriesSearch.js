// Fallback discovery only. Queries may change spelling/presentation; a result
// must still equal the full requested title or an explicitly reviewed alias.
// Never use this module to rewrite stored tags or to relax episode validation.
const {queryForms:MAX_QUERIES, fallbackRequests:MAX_REQUESTS,
  pages:MAX_PAGES, candidates:MAX_CANDIDATES} = require('./TaggingLimits').series;

const {SERIES_ALIASES:ALIASES} = require('./CatalogAliases');

const {fold:foldText,seriesDiscoveryKey:titleKey} = require('./TitleNormalization');
const fold = value => foldText(value,true);

// Interpret only annotations actually present in the series tag. In particular
// this does not inspect filenames or borrow a video's episode-release year.
function cleanSeriesInput(parts) {
  let title = String(parts.title || '').trim();
  let year = parts.year || null;
  const dottedInitials = /^(?:[a-z]\.+){2,}[a-z]?\.?$/i.test(title);
  if (!dottedInitials && !/^\d+(?:\.\d+){2,}$/.test(title)) title = title.replace(/[._]+/g, ' ');
  // A recognized season/collection annotation starts a release suffix. An
  // ordinary title like "Complete Savages", "Extras", or "Season of Love"
  // is not an annotation. Do not generically delete parenthetical titles.
  title = title.replace(/[\s\-–—+\[(]+(?:(?:the\s+)?complete\s+(?:(?:animated\s+)?(?:tv\s+)?series|\d+\s+dvd\s+collection)|seasons?(?:'s|s')?\s+\d)[\s\S]*$/i, '')
    .replace(/\s+complete(?=\s*(?:$|\())[^]*$/i, '')
    .replace(/\s*\[(?:BD\b|\d{3,4}[pi]\b|Dual Audio\b|Season\s+\d)[^]*$/i, '')
    .replace(/\s+\d{3,4}[pi]\b[^]*$/i, '').trim();
  const date = title.match(/\s*[\[(]?((?:19|20)\d{2})(?:\s*[-–—]\s*(?:19|20)\d{2})?[\])]?(?:\s*\((?:complete|tv series)\b[^]*\))?\s*$/i);
  if (date && date.index > 0) {
    if (!year) year = date[1];
    title = title.slice(0, date.index).trim();
  }
  title = title.replace(/[\s\-–—+\[(]+$/g, '').replace(/^(.+),\s*(The|An|A)$/i, '$2 $1')
    .replace(/\s+/g, ' ').trim();
  return {title, year};
}

function buildQueries(parts) {
  const cleaned = cleanSeriesInput(parts);
  if (!cleaned.title || cleaned.title.length > 240) return [];
  const result = [];
  const identity = titleKey(cleaned.title);
  const alias = ALIASES.find(item => item.names.some(name => titleKey(name) === identity));
  function add(title, reason, rule = {}) {
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (!title || result.some(query => query.title.toLowerCase() === title.toLowerCase())) return;
    result.push({title, year:cleaned.year, reason, identityTitles:[cleaned.title], ...rule});
  }
  add(cleaned.title, 'cleaned series tag');
  if (alias) {
    const names = alias.titles || alias.names;
    for (const name of names) add(name, 'reviewed series alias', {
      identityTitles:names, imdbID:alias.imdbID, aliasYear:alias.year
    });
  }
  add(fold(cleaned.title), 'normalized accents and ligatures');
  if (/\baeon\b/i.test(cleaned.title)) add(cleaned.title.replace(/\baeon\b/gi, 'Æon'), 'equivalent ligature');
  if (/\band\b/i.test(cleaned.title)) add(cleaned.title.replace(/\band\b/gi, '&'), 'and/ampersand');
  if (cleaned.title.includes('&')) add(cleaned.title.replace(/&/g, 'and'), 'and/ampersand');
  const words = cleaned.title.split(/\s+/);
  if (words.length >= 2 && words.length <= 3 && cleaned.title.length <= 24) {
    add(words.join(''), 'joined title spacing');
  }
  add(cleaned.title.replace(/([a-z])([A-Z])/g, '$1 $2'), 'separated title spacing');
  if (/^(?:[a-z]\.+){2,}[a-z]?\.?$/i.test(cleaned.title)) add(titleKey(cleaned.title).toUpperCase(), 'dotted initials');
  // A short keyword query may discover punctuation the catalog requires, but
  // candidate matching below still requires the complete identity title.
  if (words.length > 1) {
    const keywords = words.filter(word => !/^(?:the|a|an|and|of|in|to)$/i.test(word));
    const longest = keywords.slice().sort((a,b) => b.length-a.length)[0];
    if (longest && longest.length >= 5) add(longest, 'distinctive title word');
  }
  return result.slice(0, MAX_QUERIES);
}

function candidateRejection(query, candidate) {
  if (!candidate || candidate.Type !== 'series' || !/^tt\d+$/.test(candidate.imdbID || '')) return 'not a series record';
  if (query.year && !String(candidate.Year || '').startsWith(String(query.year))) return 'different requested premiere year';
  if (query.imdbID && candidate.imdbID !== query.imdbID) return 'different reviewed alias identity';
  if (query.aliasYear && !String(candidate.Year || '').startsWith(query.aliasYear)) return 'different reviewed alias year';
  if (!query.identityTitles.some(title => titleKey(title) === titleKey(candidate.Title))) return 'different full series title';
  return null;
}

// An explicit region label must constrain even the original search: OMDb may
// itself ignore "US" and return the UK adaptation as a fuzzy/contained hit.
function regionRejection(parts, candidate) {
  const title = titleKey(cleanSeriesInput(parts).title);
  const alias = ALIASES.find(item => item.titles && item.names.some(name => titleKey(name) === title));
  if (!alias) return null;
  return candidate.imdbID === alias.imdbID && String(candidate.Year || '').startsWith(alias.year) ?
    null : 'different explicitly requested region';
}

const {equivalentSeriesTitles:equivalentTitles} = require('./CatalogAliases');

function createSession() {
  return {queries:new Map(), logged:new Set(), requests:0, reused:0, fallbackRequests:0, recovered:new Map(),
    parents:new Map(), episodeIndexes:new Map(), singleSeasons:new Map(),
    catalog:require('./CatalogClient').createRequestSession()};
}

function sessionSummary(session) {
  return {seriesRequests:session.requests, reusedSeriesRequests:session.reused,
    catalogRequests:session.catalog.requests, reusedCatalogRequests:session.catalog.reused,
    fallbackRequests:session.fallbackRequests, recoveredSeries:[...session.recovered.values()]};
}

module.exports = {buildQueries, candidateRejection, regionRejection, cleanSeriesInput, titleKey, equivalentTitles,
  createSession, sessionSummary, MAX_QUERIES, MAX_REQUESTS, MAX_PAGES, MAX_CANDIDATES};
