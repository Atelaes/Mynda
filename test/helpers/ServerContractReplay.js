// Preloaded only by scripts/test-metadata-server.js. Historical tests keep their
// original recorded OMDb replies and expected decisions; only their transport
// is routed through the real desktop adapter, server router and OMDb adapter.
const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
const clientPath = path.resolve(__dirname, '../../src/tagging/CatalogClient.js');
const {handleRequest, MetadataService, OmdbProvider} = require(process.env.MYNDA_SERVER_TEST_BUNDLE);
const token = 'synthetic-server-contract-replay-token-only';
const networkBlocked = () => { throw new Error('Network access is disabled during the server contract replay.'); };
globalThis.fetch = networkBlocked;
require('http').request = networkBlocked;
require('https').request = networkBlocked;
let requests = 0, providerRequests = 0;

Module._load = function(request, parent, isMain) {
  const result = originalLoad.call(this, request, parent, isMain);
  if (Module._resolveFilename(request, parent) !== clientPath) return result;
  return {...result, createCatalogClient(options) {
    const fixtureAxios = options.axios;
    return result.createCatalogClient({...options, transport:undefined, server:{url:'http://127.0.0.1:8787', token}, axios:async config => {
      requests++;
      const provider = new OmdbProvider({apiKey:'fixture-only', fetch:async input => {
        providerRequests++;
        const url = new URL(input);
        // These are provider defaults, not new discovery inputs. Historical
        // recordings omitted r=json and page=1 unless explicitly requested.
        url.searchParams.delete('r');
        if (config.data.page === undefined && url.searchParams.get('page') === '1') url.searchParams.delete('page');
        const raw = await fixtureAxios({url:url.href});
        // These old response SUMMARIES omitted pagination. Model their saved
        // rows as an explicitly finite fixture result set so this test remains
        // a normalization/matching replay. This synthetic total is NOT captured
        // OMDb evidence or a claim about live search completeness. Real unknown
        // pagination is tested separately and must remain unresolved when the
        // episode/collection evidence cannot establish a parent.
        const data = raw.data;
        return Response.json(data && data.Response === 'True' && Array.isArray(data.Search) && data.totalResults == null ?
          {...data,totalResults:String((Number(url.searchParams.get('page') || 1)-1)*10+data.Search.length)} : data);
      }});
      const response = await handleRequest(new Request(config.url, {
        method:config.method, headers:config.headers, body:JSON.stringify(config.data),
      }), {clientTokens:JSON.stringify({torgo:token}), service:() => new MetadataService(provider), logger() {}});
      return {status:response.status, data:await response.json()};
    }});
  }};
};

process.on('exit', () => console.log(`Server contract replay: ${requests} service requests, ${providerRequests} recorded provider responses; network disabled.`));
