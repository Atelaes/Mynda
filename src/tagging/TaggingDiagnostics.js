function summarizeVideo(video) {
  return {
    id: video && video.id,
    filename: video && video.filename,
    title: video && video.title,
    kind: video && video.kind,
    year: video && video.year,
    series: video && video.series,
    seriesImdbID: video && video.seriesImdbID,
    season: video && video.season,
    episode: video && video.episode,
    imdbID: video && video.imdbID
  };
}

function summarizeError(error) {
  let source = error && error.Error ? error.Error : error;
  if (!source || typeof source !== 'object') {
    return source;
  }
  return {
    name: source.name,
    message: source.message,
    code: source.code,
    httpStatus: source.response && source.response.status,
    httpStatusText: source.response && source.response.statusText,
    stack: source.stack
  };
}

function requestParametersForLog(urlParts) {
  try {
    let requestURL = new URL(urlParts.join('&'));
    let parameters = {};
    requestURL.searchParams.forEach((value, key) => {
      if (key.toLowerCase() !== 'apikey') {
        parameters[key] = value;
      }
    });
    return parameters;
  } catch(err) {
    // The first array member contains the API key. Never include it in the
    // fallback diagnostic representation.
    return {unparsedParameters: urlParts.slice(1)};
  }
}

function summarizeOMDbResponse(response) {
  let data = response && response.data ? response.data : {};
  let summary = {
    httpStatus: response && response.status,
    httpStatusText: response && response.statusText,
    response: data.Response,
    error: data.Error,
    title: data.Title,
    year: data.Year,
    type: data.Type,
    imdbID: data.imdbID,
    runtime: data.Runtime,
    genre: data.Genre,
    imdbVotes: data.imdbVotes,
    seriesID: data.seriesID,
    season: data.Season,
    episode: data.Episode
  };
  if (Array.isArray(data.Search)) {
    summary.resultCount = data.Search.length;
    summary.results = data.Search.slice(0, 20).map(result => ({
      title: result.Title,
      year: result.Year,
      type: result.Type,
      imdbID: result.imdbID
    }));
  }
  if (Array.isArray(data.Episodes)) {
    summary.episodeCount = data.Episodes.length;
    summary.episodes = data.Episodes.slice(0, 30).map(result => ({
      title: result.Title,
      released: result.Released,
      episode: result.Episode,
      imdbID: result.imdbID
    }));
  }
  return summary;
}

module.exports = {summarizeVideo, summarizeError, requestParametersForLog, summarizeOMDbResponse};
