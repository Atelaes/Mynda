// The sole OMDb HTTP boundary. Cache hits do not spend the operation's budget;
// every actual request, including nested probes and retries, spends it here.
const {requestParametersForLog,summarizeOMDbResponse,summarizeError} = require('./TaggingDiagnostics');
const {isNotFoundResponse} = require('./CatalogResponse');
const {createRequestBudget,spendRequest} = require('./RequestBudget');
const Limits = require('./TaggingLimits');

function createRequestSession() { return {responses:new Map(),requests:0,reused:0}; }

function createCatalogClient({axios,omdb,log}) {
  function createURLParts(parts) {
    const url = [`https://www.omdbapi.com/?apikey=${encodeURIComponent(omdb.key)}`];
    const names = {id:'i',title:'s',exactTitle:'t',year:'y',type:'type',series:'t',season:'Season',episode:'Episode',page:'page'};
    for (const [name,parameter] of Object.entries(names)) {
      if (parts[name] != null && parts[name] !== '') url.push(`${parameter}=${encodeURIComponent(parts[name])}`);
    }
    return url;
  }

  async function request(urlParts,context,parameters,observation) {
    spendRequest(context.requestBudget,context.stage);
    observation.issued = true;
    if (context.requestSession) context.requestSession.requests++;
    log.debug('OMDb request started',{searchID:context.searchID,stage:context.stage,parameters});
    try {
      const response = await axios({method:'get',url:urlParts.join('&'),timeout:Limits.timeoutMs});
      log.debug('OMDb response received',{searchID:context.searchID,stage:context.stage,
        request:parameters,response:summarizeOMDbResponse(response)});
      return response;
    } catch(error) {
      log.error('OMDb request failed',{searchID:context.searchID,stage:context.stage,
        request:parameters,error:summarizeError(error)});
      throw error;
    }
  }

  async function pollOMDB(urlParts,context = {}) {
    const session = context.requestSession;
    context.requestBudget = context.requestBudget || createRequestBudget();
    const parameters = requestParametersForLog(urlParts);
    const key = JSON.stringify(Object.keys(parameters).sort().map(name => [name,parameters[name]]));
    const cached = session && session.responses.has(key);
    const observation = {stage:context.stage,parameters,reused:Boolean(cached)};
    if (context.requestTrace) context.requestTrace.push(observation);
    let pending;
    if (cached) {
      session.reused++;
      pending = session.responses.get(key);
      log.debug('Reusing catalog response',{searchID:context.searchID,stage:context.stage,parameters});
    } else {
      // The async request charges synchronously before its first await, so
      // concurrent distinct probes cannot race past the shared limit.
      pending = request(urlParts,context,parameters,observation);
      if (session) {
        if (session.responses.size >= Limits.cachedResponses) session.responses.delete(session.responses.keys().next().value);
        session.responses.set(key,pending);
      }
    }
    try {
      const response = await pending;
      const data = response && response.data;
      const cacheable = response && response.status === 200 && data &&
        (isNotFoundResponse(data) || (data.Response === 'True' &&
          (Array.isArray(data.Search) || Array.isArray(data.Episodes) ||
           (/^tt\d+$/.test(data.imdbID || '') && typeof data.Title === 'string' && data.Title.trim() &&
             ['series','episode','movie'].includes(data.Type)))));
      observation.outcome = data && data.Response === 'True' ? 'response' :
        isNotFoundResponse(data) ? 'not-found' : 'service-error';
      if (!cacheable && session && session.responses.get(key) === pending) session.responses.delete(key);
      return response;
    } catch(error) {
      observation.outcome = 'service-error';
      observation.code = error.code || 'transport-error';
      if (session && session.responses.get(key) === pending) session.responses.delete(key);
      throw error;
    }
  }
  return {createURLParts,pollOMDB};
}
module.exports = {createCatalogClient,createRequestSession};
