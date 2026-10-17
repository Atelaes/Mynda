const CatalogIdentity = require('./CatalogIdentity');
// Catalog response shapes and predictable failures. No network or application state.
function validImdbID(value) {
  return typeof value === 'string' && /^tt\d+$/.test(value.trim());
}

function validSeriesImdbID(value) {
  return validImdbID(value);
}

function normalizeEpisodeNumber(value) {
  let stringValue = String(value).trim();
  stringValue = stringValue.replace(/\.0$/, '');
  if (!/^\d+$/.test(stringValue)) {
    return null;
  }
  return stringValue.replace(/^0+(?=\d)/, '');
}

function isNotFoundResponse(data) {
  return data && data.Response === 'False' && /not found|no results/i.test(data.Error || '');
}

function isTooManyResultsResponse(data) {
  return data && data.Response === 'False' && /too many results/i.test(data.Error || '');
}

function predictableFailure(failure, data) {
  return {
    success: false,
    failure: failure,
    data: data,
    // autoTag() can record this attempt instead of retrying the same
    // untaggable video every time. Saving it in the editor resets the flag.
    permanentFailure: true
  };
}

function requestFailure(response) {
  if (!response || response.status !== 200) {
    return {
      success: false,
      failure: response ? response.status : 'Error',
      data: response ? response.statusText : 'No response from the catalog'
    };
  }
  if (response.data && response.data.Response === 'True') {
    return null;
  }
  if (isNotFoundResponse(response.data)) {
    return predictableFailure('No results', response.data.Error);
  }
  if (isTooManyResultsResponse(response.data)) {
    return predictableFailure('Ambiguous results', response.data.Error);
  }
  return {
    success: false,
    failure: 'Error',
    data: response.data && response.data.Error ? response.data.Error : 'Unexpected catalog response'
  };
}

function episodeResponseMatches(data, seriesID, season, episode) {
  return data && data.Response === 'True' && data.Type === 'episode' &&
    CatalogIdentity.recordKey(data) && normalizeEpisodeNumber(data.Season) === season &&
    normalizeEpisodeNumber(data.Episode) === episode &&
    (!CatalogIdentity.parentKey(data) || CatalogIdentity.matchesParent(data,seriesID));
}

module.exports = {validImdbID, validSeriesImdbID, normalizeEpisodeNumber, isNotFoundResponse, isTooManyResultsResponse, predictableFailure, requestFailure, episodeResponseMatches};
