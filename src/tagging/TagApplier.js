const _ = require('lodash');
const Response = require('./CatalogResponse');
const {validSeriesImdbID} = Response;
const {summarizeError} = require('./TaggingDiagnostics');

function createTagApplier({log, downloadArtworkWithSeriesFallback}) {

  const {parseOmdbBoxOffice} = require("../library/BoxOffice");
  function addTagsToVideo(video, data, context = {}) {
    //console.log(JSON.stringify(video));
    video.imdbID = data.imdbID;
    if (video.kind === 'show') {
      if (validSeriesImdbID(data.seriesID)) {
        video.seriesImdbID = data.seriesID.trim();
      } else if (!validSeriesImdbID(video.seriesImdbID)) {
        video.seriesImdbID = '';
      }
    } else {
      video.seriesImdbID = '';
    }
    video.title = data.Title;
    delete video.Title;
    video.description = data.Plot;
    video.artwork = data.Poster; // the MynEditArtwork component will do the work to actually download the image from this url and change the reference to the local file when finished
    if (video.artwork === "N/A") video.artwork = '';
    delete video.Poster;
    video.year = data.Year;
    delete video.Year;
    video.director = data.Director,
    // OMDb's Type describes its record, not the user's Mynda category. In
    // particular, overwriting this field destroyed custom kinds. The video was
    // already categorized before tagging, so preserve that value unchanged.
    delete video.Type;
    video.country = data.Country;
    video.rated = data.Rated;
    try {
      video.boxoffice = parseOmdbBoxOffice(data.BoxOffice);
    } catch(err) { log.debug('OMDb did not supply a usable box-office value', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      video.directorsort = /^\w+\s\w+$/.test(data.Director) ? data.Director.replace(/^(\w+)\s(\w+)$/,($match,$1,$2) => `${$2}, ${$1}`) : data.Director; // if the director field consists only of a first and last name separated by a space, set directorsort to 'lastname, firstname', otherwise, leave as-is and let the user edit it manually
    } catch(err) { log.debug('OMDb did not supply a usable director-sort value', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      video.cast = data.Actors.split(', ');
    } catch(err) { log.debug('OMDb did not supply usable actors', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      video.genre = data.Genre.split(', ')[0]; // just pick the first genre for genre, since we only allow one
    } catch(err) { log.debug('OMDb did not supply a usable primary genre', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      video.languages = data.Language.split(', ');
    } catch(err) { log.debug('OMDb did not supply usable languages', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      video.tags = video.tags || [];
      video.tags = Array.from(new Set(data.Genre.split(', ').map((item) => item.toLowerCase()).concat(video.tags))); // add new tags to existing tags, removing duplicates
    } catch(err) { log.debug('OMDb did not supply usable genre tags', {searchID: context.searchID, error: summarizeError(err)}); }
    let ratings = _.cloneDeep(video.ratings) || {};
    try {
      ratings.imdb = Number(data.Ratings.filter(object => object.Source == "Internet Movie Database")[0].Value.match(/^[\d\.]+(?=\/)/)); // / 10;
    } catch(err) { log.debug('OMDb did not supply an IMDb rating', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      ratings.rt = Number(data.Ratings.filter(object => object.Source == "Rotten Tomatoes")[0].Value.match(/^\d+/)); // / 100;
    } catch(err) { log.debug('OMDb did not supply a Rotten Tomatoes rating', {searchID: context.searchID, error: summarizeError(err)}); }
    try {
      ratings.mc = Number(data.Ratings.filter(object => object.Source == "Metacritic")[0].Value.match(/^\d+(?=\/)/)); // / 100;
    } catch(err) { log.debug('OMDb did not supply a Metacritic rating', {searchID: context.searchID, error: summarizeError(err)}); }
    video.ratings = ratings;
    return video;
  }

  async function applyGeneralVideoResult(video, omdbData, context) {
    let taggedVideo = addTagsToVideo(_.cloneDeep(video), omdbData, context);
    taggedVideo.artwork = await downloadArtworkWithSeriesFallback(
      omdbData,
      omdbData.Type === 'episode' ? omdbData.seriesID : null,
      context
    );
    return {success: true, data: taggedVideo};
  }
  return {apply:applyGeneralVideoResult};
}

module.exports = {createTagApplier};
