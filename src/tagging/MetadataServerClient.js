const Identity = require('./CatalogIdentity');
// Translate the v1 service contract at the existing catalog boundary. Matching,
// discovery, caching and library updates remain with their existing owners.
const {validateServerConfig, configurationMessage} = require('./MetadataServerConfig');
const {capacityWait,waitForCapacity,canceled} = require('./CapacityWait');
let nextWaitID = 0;
const MESSAGES = {
  UNAUTHORIZED: 'Mynda’s license key was not accepted. Open Settings → License to check activation.',
  PROVIDER_AUTH_ERROR: 'The metadata server could not authenticate with its provider.',
  PROVIDER_QUOTA_EXCEEDED: 'The metadata provider usage limit has been reached. Try again later.',
  PROVIDER_TIMEOUT: 'The metadata provider did not respond in time.',
  PROVIDER_UNAVAILABLE: 'The metadata provider is temporarily unavailable.',
  PROVIDER_INVALID_RESPONSE: 'The metadata provider returned invalid or inconsistent data.',
  CONFIGURATION_ERROR: 'The metadata server is not configured correctly.',
  CAPACITY_UNAVAILABLE: 'The metadata server cannot check its shared capacity. Please try again later.',
  BAD_REQUEST: 'The metadata server rejected the lookup parameters.',
  UNSUPPORTED: 'The metadata server does not support this lookup.',
};
const safeID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
function serviceError(code, message, response) {
  const error = new Error(message);
  error.name = 'MetadataServiceError';
  error.code = code;
  if (response) {
    error.response = {status: response.status};
    error.requestId = safeID(response.data && response.data.requestId);
  }
  return error;
}
function invalid() { throw serviceError('METADATA_INVALID_RESPONSE', 'The metadata server returned an invalid response.'); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const imdbID = value => typeof value === 'string' && /^tt\d{7,12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const optionalText = value => value === null || typeof value === 'string';
const legacyText = value => value === null ? 'N/A' : value;
function list(value) {
  if (value === null) return 'N/A';
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return invalid();
  return value.join(', ');
}
function reference(value) {
  const ref=Identity.native(value);
  return ref || invalid();
}
function summary(data) {
  if (!object(data) || !object(data.externalIds) || (data.externalIds.imdb !== undefined && !imdbID(data.externalIds.imdb)) ||
      typeof data.title !== 'string' || !data.title.trim() ||
      !['movie', 'series', 'episode'].includes(data.kind) || !Array.isArray(data.artwork)) return invalid();
  const ref = reference(data.ref);
  if (data.year !== null && (!object(data.year) || typeof data.year.text !== 'string' ||
      ![data.year.start, data.year.end].every(value => value === null || integer(value)))) return invalid();
  const poster = data.artwork.find(item => object(item) && item.type === 'poster');
  let posterURL = 'N/A';
  if (poster) {
    let url;
    try { url = new URL(poster.url); } catch (_) { return invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return invalid();
    posterURL = url.href;
  }
  return {Title: data.title, Type: data.kind, Year: data.year === null ? 'N/A' : data.year.text,
    imdbID: data.externalIds.imdb || '', Poster: posterURL, catalogRef: ref};
}
function record(data) {
  const result = {Response: 'True', ...summary(data)};
  for (const [source, target] of Object.entries({released:'Released', plot:'Plot', contentRating:'Rated', boxOffice:'BoxOffice'})) {
    if (!optionalText(data[source])) return invalid();
    result[target] = legacyText(data[source]);
  }
  for (const [source, target] of Object.entries({genres:'Genre', directors:'Director', actors:'Actors', countries:'Country', languages:'Language'})) {
    result[target] = list(data[source]);
  }
  if (data.runtimeMinutes !== null && (!Number.isFinite(data.runtimeMinutes) || data.runtimeMinutes <= 0)) return invalid();
  result.Runtime = data.runtimeMinutes === null ? 'N/A' : `${data.runtimeMinutes} min`;
  for (const [source, target] of Object.entries({season:'Season', episode:'Episode', totalSeasons:'totalSeasons'})) {
    if (data[source] !== null && !integer(data[source])) return invalid();
    result[target] = data[source] === null ? 'N/A' : String(data[source]);
  }
  if (!Array.isArray(data.ratings) || !Array.isArray(data.votes)) return invalid();
  result.Ratings = data.ratings.map(rating => {
    if (!object(rating) || typeof rating.source !== 'string' || typeof rating.value !== 'string') return invalid();
    return {Source: rating.source, Value: rating.value};
  });
  const votes = data.votes.find(item => object(item) && item.source === 'imdb');
  if (votes && !integer(votes.count)) return invalid();
  result.imdbVotes = votes ? String(votes.count) : 'N/A';
  const parentID = seriesIMDbID(data);
  if (data.series !== null) {
    result.catalogSeriesRef = reference(data.series);
    result.seriesID = parentID || Identity.keyFromRef(result.catalogSeriesRef);
    result.seriesImdbID = parentID || '';
  }
  result.catalogEpisodeOrder = data.episodeOrder;
  return result;
}
function seriesIMDbID(data) {
  // Native catalog references are opaque. Only an explicit cross-reference
  // from the server can establish the parent identity used by Mynda's library.
  if (!object(data.seriesExternalIds)) return invalid();
  const parentID = data.seriesExternalIds.imdb;
  if (parentID !== undefined && (!imdbID(parentID) || data.series === null)) return invalid();
  return parentID;
}
function translate(data, route, body) {
  if (!object(data) || !object(data.provenance) || typeof data.provenance.provider !== 'string') return invalid();
  if (route === '/v1/search') {
    if (!Array.isArray(data.items) || data.page !== (body.page || 1) ||
        !(data.totalResults === null || integer(data.totalResults)) ||
        ![true, false, null].includes(data.hasMore)) return invalid();
    const Search = data.items.map(summary);
    if (!Search.length) return {Response:'False', Error:'Movie not found!'};
    return {Response:'True', Search, ...(data.totalResults === null ? {} : {totalResults:String(data.totalResults)}),
      catalogHasMore:data.hasMore, catalogPage:data.page};
  }
  if (route === '/v1/season') {
    const parent = reference(data.series);
    const parentID = seriesIMDbID(data);
    if (!integer(data.season) || data.season !== body.season || !Array.isArray(data.episodes) ||
        data.order !== 'provider' || !['complete', 'partial', 'unknown'].includes(data.completeness) ||
        !(data.totalSeasons === null || integer(data.totalSeasons)) ||
        !Identity.matchesParent({catalogSeriesRef:parent,seriesImdbID:parentID},body.series)) return invalid();
    return {Response:'True', Season:String(data.season),
      totalSeasons:data.totalSeasons === null ? 'N/A' : String(data.totalSeasons),
      catalogSeriesRef:parent, seriesID:parentID || Identity.keyFromRef(parent), seriesImdbID:parentID || '', catalogCompleteness:data.completeness,
      Episodes:data.episodes.map(item => {
        if (!object(item) || !object(item.externalIds) || (item.externalIds.imdb !== undefined && !imdbID(item.externalIds.imdb)) ||
            typeof item.title !== 'string' || !(item.episode === null || integer(item.episode)) ||
            !optionalText(item.released)) return invalid();
        return {imdbID:item.externalIds.imdb || '', Title:item.title,
          Episode:item.episode === null ? 'N/A' : String(item.episode), Released:legacyText(item.released),
          catalogRef:reference(item.ref)};
      })};
  }
  const result = record(data);
  if ((route === '/v1/record' && !Identity.matchesRecord(result,body.ref)) ||
      (route === '/v1/title' && body.kind && result.Type !== body.kind) ||
      (route === '/v1/episode' && (result.Type !== 'episode' || data.season !== body.season ||
        data.episode !== body.episode || !Identity.matchesParent(result,body.series)))) return invalid();
  return result;
}

function lookup(parameters) {
  const optional = {};
  if (parameters.type) optional.kind = parameters.type;
  if (parameters.year) optional.year = Number(parameters.year);
  if (parameters.id) {
    const ref = Identity.lookup(parameters.id);
    if (!ref) throw serviceError('METADATA_BAD_REQUEST','A metadata lookup requires a valid catalog reference or IMDb ID.');
    if (parameters.season !== undefined) {
      const body = {series:ref, season:Number(parameters.season), order:'provider'};
      if (parameters.episode !== undefined) return {route:'/v1/episode', body:{...body, episode:Number(parameters.episode)}};
      return {route:'/v1/season', body};
    }
    return {route:'/v1/record', body:{ref}};
  }
  if (parameters.title) return {route:'/v1/search', body:{title:parameters.title, ...optional,
    ...(parameters.page ? {page:Number(parameters.page)} : {})}};
  if (parameters.exactTitle) return {route:'/v1/title', body:{title:parameters.exactTitle, ...optional}};
  throw serviceError('METADATA_BAD_REQUEST', 'A metadata lookup requires a title or catalog identity.');
}

function createMetadataServerClient({axios, server, onUnauthorized, wait = waitForCapacity, now = Date.now}) {
  return async function request(parameters, control = {}) {
    let config;
    try { config = validateServerConfig(typeof server === 'function' ? await server() : server); }
    catch (_) { /* Fail on lookup, not app startup. */ }
    if (!config) throw serviceError('METADATA_CONFIGURATION_ERROR', configurationMessage);
    const {route, body} = lookup(parameters);
    const waitID = ++nextWaitID;
    let ticket, waiting = false;
    try {
      while (true) {
        if (control.signal && control.signal.aborted) throw canceled();
        if (waiting && typeof server === 'function') {
          let latest;
          try { latest = await server(); } catch (_) { /* Access was removed or became unavailable. */ }
          if (!latest || latest.url !== config.url || latest.token !== config.token) {
            throw serviceError('METADATA_CONFIGURATION_CHANGED', 'Mynda’s activation changed while this lookup was waiting. Try the lookup again.');
          }
        }
        const response = await send(config, route, body, ticket, control);
        if (response && [401,403].includes(response.status)) {
          if (onUnauthorized) await onUnauthorized(config);
          throw serviceError('UNAUTHORIZED', MESSAGES.UNAUTHORIZED, response);
        }
        const envelope = response && response.data;
        if (!object(envelope) || !safeID(envelope.requestId)) throw serviceError('METADATA_INVALID_RESPONSE',
          'The metadata server returned an invalid response.', response);
        const capacity = capacityWait(response);
        if (capacity) {
          ticket = capacity.ticket;
          if (control.isCanceled && control.isCanceled()) throw canceled();
          waiting = true;
          if (control.onCapacityWait) await control.onCapacityWait({waiting:true,waitID,
            reason:capacity.reason,retryAfterSeconds:capacity.retryAfterSeconds,retryAt:now() + capacity.retryAfterSeconds * 1000});
          await wait(capacity.retryAfterSeconds * 1000, control.signal);
          continue;
        }
        if (response.status !== 200) {
          const code = envelope.error && envelope.error.code;
          if ((response.status === 404 && code === 'NOT_FOUND') || (response.status === 422 && code === 'TOO_MANY_RESULTS')) {
            return {status:200, data:{Response:'False', Error:code === 'NOT_FOUND' ? 'Movie not found!' : 'Too many results.'},
              requestId:envelope.requestId};
          }
          const known = Object.hasOwn(MESSAGES, code);
          throw serviceError(known ? code : 'METADATA_SERVICE_ERROR',
            known ? MESSAGES[code] : 'The metadata server could not complete the lookup.', response);
        }
        try {
          return {status:200, data:translate(envelope.data, route, body), requestId:envelope.requestId};
        } catch (error) {
          throw serviceError('METADATA_INVALID_RESPONSE', 'The metadata server returned an invalid response.', response);
        }
      }
    } finally {
      if (waiting && control.onCapacityWait) await control.onCapacityWait({waiting:false,waitID});
    }
  };

  async function send(config, route, body, ticket, control) {
    let response;
    const signal = control.signal;
    const source = axios.CancelToken && axios.CancelToken.source();
    let abort;
    try {
      const interrupted = new Promise((_, reject) => {
        abort = () => { if (source) source.cancel(); reject(canceled()); };
        if (signal) signal.addEventListener('abort', abort, {once:true});
      });
      const operation = axios({method:'post', url:config.url + route, data:body,
        headers:{Authorization:`Bearer ${config.token}`, 'Content-Type':'application/json',
          'X-Metadata-Workload':control.workload === 'batch' ? 'batch' : 'interactive',
          ...(ticket ? {'X-Metadata-Ticket':ticket} : {})},
        // The server can spend up to 20.1 seconds on its two provider attempts.
        timeout:30000, maxRedirects:0, maxContentLength:1024 * 1024,
        proxy:false, ...(source ? {cancelToken:source.token} : {}), validateStatus:() => true});
      response = await Promise.race([operation, interrupted]);
    } catch (error) {
      if (signal && signal.aborted) throw canceled();
      // Axios errors retain the Authorization header and request config. Never
      // pass the original error into logging, saved evidence, or renderer IPC.
      const timeout = error && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
      throw serviceError(timeout ? 'METADATA_TIMEOUT' : 'METADATA_UNAVAILABLE', timeout ?
        'The metadata server did not respond in time.' : 'Could not reach the metadata server. Check your connection and metadata server settings.');
    } finally {
      if (signal && abort) signal.removeEventListener('abort', abort);
    }
    return response;
  }
}

module.exports = {createMetadataServerClient};
