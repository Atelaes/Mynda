const CatalogIdentity = require('./CatalogIdentity');
// The sole metadata HTTP boundary. Cache hits do not spend the operation's budget;
// each logical lookup spends it here. Capacity polling stays inside the transport;
// provider attempts (including retries) are accounted for by the server.
const {summarizeCatalogResponse,summarizeError} = require('./TaggingDiagnostics');
const {isNotFoundResponse} = require('./CatalogResponse');
const {createRequestBudget,spendRequest} = require('./RequestBudget');
const Limits = require('./TaggingLimits');
const {createMetadataServerClient} = require('./MetadataServerClient');

function createRequestSession() { return {responses:new Map(),requests:0,reused:0}; }

function createCatalogClient({axios,log,server,onUnauthorized,
  transport = createMetadataServerClient({axios,server,onUnauthorized})}) {
  function createCatalogQuery(parts) {
    // Detached, whitelisted metadata inputs are also safe to use in diagnostics.
    // Credentials and HTTP details belong exclusively to MetadataServerClient.
    const query = {};
    for (const name of ['id','title','exactTitle','year','type','season','episode','page']) {
      if (parts[name] != null && parts[name] !== '') query[name] = String(parts[name]);
    }
    if (parts.series != null && parts.series !== '') query.exactTitle = String(parts.series);
    return query;
  }

  async function request(context,parameters,observation) {
    spendRequest(context.requestBudget,context.stage);
    observation.issued = true;
    if (context.requestSession) context.requestSession.requests++;
    log.debug('Metadata server request started',{searchID:context.searchID,stage:context.stage,parameters});
    try {
      const response = await transport(parameters, context.requestControl ||
        (context.requestSession && context.requestSession.control) || {});
      if (response && response.requestId) observation.requestId = response.requestId;
      log.debug('Metadata server response received',{searchID:context.searchID,stage:context.stage,
        requestId:response && response.requestId,request:parameters,response:summarizeCatalogResponse(response)});
      return response;
    } catch(error) {
      if (error.requestId) observation.requestId = error.requestId;
      log[error.code === 'METADATA_CANCELED' ? 'debug' : 'error'](
        error.code === 'METADATA_CANCELED' ? 'Metadata lookup canceled' : 'Metadata server request failed',{searchID:context.searchID,stage:context.stage,
        request:parameters,error:summarizeError(error)});
      throw error;
    }
  }

  async function requestCatalog(query,context = {}) {
    const session = context.requestSession;
    context.requestBudget = context.requestBudget || createRequestBudget();
    const parameters = createCatalogQuery(query);
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
      pending = request(context,parameters,observation);
      if (session) {
        if (session.responses.size >= Limits.cachedResponses) session.responses.delete(session.responses.keys().next().value);
        session.responses.set(key,pending);
      }
    }
    try {
      const response = await pending;
      if (response && response.requestId) observation.requestId = response.requestId;
      const data = response && response.data;
      const cacheable = response && response.status === 200 && data &&
        (isNotFoundResponse(data) || (data.Response === 'True' &&
          (Array.isArray(data.Search) || Array.isArray(data.Episodes) ||
           (CatalogIdentity.recordKey(data) && typeof data.Title === 'string' && data.Title.trim() &&
             ['series','episode','movie'].includes(data.Type)))));
      observation.outcome = data && data.Response === 'True' ? 'response' :
        isNotFoundResponse(data) ? 'not-found' : 'service-error';
      if (!cacheable && session && session.responses.get(key) === pending) session.responses.delete(key);
      return response;
    } catch(error) {
      observation.outcome = 'service-error';
      observation.code = error.code || 'transport-error';
      if (error.requestId) observation.requestId = error.requestId;
      if (session && session.responses.get(key) === pending) session.responses.delete(key);
      throw error;
    }
  }
  return {createCatalogQuery,requestCatalog};
}
module.exports = {createCatalogClient,createRequestSession};
