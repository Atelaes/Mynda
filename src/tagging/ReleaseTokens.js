// Technical vocabulary only. Callers must first establish a release/numbering context;
// these words cannot be removed indiscriminately from real episode titles.
const BASE = /^(?:\d{3,4}[pi]|uhd|hdtv|pdtv|dsr|web|webrip|webdl|dl|bluray|bdrip|brrip|dvdrip|dvd|dsnp|amzn|netflix|nf|[hx]26[45]|hevc|xvid|divx|aac|ac3|eac3|ddp\d?|dts|mp3|10bit|8bit|repack|proper|internal|mkv|mp4|avi|shaanig|sujaidr|scotluhd|depth|galaxytv|galaxyrg|torrentgalaxy|xor|lol|0tv|fov|asap|evolve|dimension|immerse|killers|sva|fleet|afg|msd|ntb|psa|joy|sfm|deity|hiqt|notv|2hd|vtv|fqm|xii)$/i;
const RELEASE_ONLY = /^(?:\d+(?:mb|gb)|multi|rip|blu|ray|taxes|moviesbyrizzo|avs|minx|kontrast|ethel|higgsboson|successfulcrab|cakes|pcok|aglet)$/i;
// Distribution labels are release metadata, regardless of the series name.
// Keep this vocabulary shared by title placeholders and collection folders.
const DISTRIBUTION = /^(?:rartv|ettv|eztv|tgx)$/i;
function isTechnicalToken(token,profile) {
  return BASE.test(token) || (profile === 'release' && (RELEASE_ONLY.test(token) || DISTRIBUTION.test(token)));
}
module.exports = {isTechnicalToken};
