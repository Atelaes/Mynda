// Test-only HTTP boundary. Matching, response parsing, caches, downloads and
// filesystem writes above it are the production implementations.
const fs = require('fs');
const {Readable} = require('stream');
const fixtures = require('./TaggingFixtures');
const metadata = require('./MetadataFixtures');
const ROUTES = new Set(['/v1/search','/v1/title','/v1/record','/v1/season','/v1/episode']);
const LIVE_LIMIT = 60;
function redact(value, secret = '') {
  let text = String(value).replace(/([?&](?:apikey|api_key)=)[^&\s"']+/gi,'$1[redacted]');
  if (secret) text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  return text;
}
function createNetwork({axios, imageBytes, live = false, server = metadata.connection, secret = server.token, file, restart = false, limit = live ? LIVE_LIMIT : 1000}) {
  const previous = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
  const requests = previous.requests || [], issues = previous.issues || [];
  const permittedPosters = new Set(previous.posters || []);
  const holds = [];
  const original = axios.defaults.adapter;
  // Poster URLs can themselves contain credentials. Keep raw URLs only in
  // memory for the allowlist; retained diagnostics must redact the whole file.
  const persist = () => { if (file) fs.writeFileSync(file,redact(JSON.stringify({requests,issues,posters:[...permittedPosters]},null,2),secret)); };
  function problem(category, message) {
    const safe = redact(message,secret);
    issues.push({category,message:safe}); persist();
    return Object.assign(new Error(safe),{code:'MYNDA_TEST_' + category.toUpperCase()});
  }
  function begin(value, transport = 'node', body = {}) {
    let url;
    try {url = new URL(value);}
    catch (_) {throw problem('unexpected-network','Malformed test network destination: ' + value);}
    const catalog = url.origin === server.url && ROUTES.has(url.pathname) && !url.search;
    const artwork = url.protocol === 'https:' && !url.port &&
      (live ? permittedPosters.has(url.href) : url.hostname === 'artwork.mynda.test');
    if (url.username || url.password || (!catalog && !artwork) || transport === 'renderer' && catalog)
      throw problem('unexpected-network','Unexpected test network destination: ' + redact(url.href,secret));
    if (restart) throw problem('unexpected-network','Restart must use saved metadata and artwork without network requests.');
    if (requests.length >= limit) throw problem('request-budget',`Test request limit (${limit}) reached.`);
    const query = catalog ? metadata.fixtureQuery(url.pathname,body) : Object.fromEntries(url.searchParams);
    delete query.apikey; delete query.api_key;
    const entry = {transport,kind:catalog ? 'catalog' : 'artwork',host:url.hostname,path:url.pathname,query};
    requests.push(entry); persist();
    return {url,query,entry,catalog};
  }
  function observe(data) {
    const result = data && data.data;
    for (const row of [result,...(result && result.items || [])]) {
      for (const image of row && row.artwork || []) try { const url = new URL(image.url);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port) permittedPosters.add(url.href);
      } catch (_) {}
    }
    if (live && data && data.error && !['NOT_FOUND','TOO_MANY_RESULTS'].includes(data.error.code)) {
      problem('provider',data.error.code || 'The metadata service rejected a lookup.');
    }
    persist();
  }
  async function adapter(config) {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    const request = begin(config.url,'node',body);
    if (request.catalog && (config.method !== 'post' || config.headers.Authorization !== `Bearer ${server.token}`))
      throw problem('unexpected-network','Metadata requests must use authenticated POSTs.');
    const hold = holds.find(item => !item.used && item.match(request));
    if (hold) { hold.used = true; hold.started.resolve(); await hold.release.promise; }
    if (!live) {
      if (request.catalog) return {...metadata.response(fixtures.catalog(request.query),request.query),headers:{},config};
      if (request.url.pathname === '/missing.png') {
        const error = new Error('Fixture artwork not found');
        error.response = {status:404,statusText:'Not Found'}; throw error;
      }
      return {status:200,statusText:'OK',headers:{'content-type':'image/png'},config,data:Readable.from(imageBytes)};
    }
    try {
      // No uncounted redirect requests through Axios's redirect implementation.
      const response = await original({...config,maxRedirects:0,timeout:Math.min(config.timeout || 30000,30000)});
      if (request.catalog) observe(typeof response.data === 'string' ? JSON.parse(response.data) : response.data);
      if (response.status !== 200 && !(request.catalog && [404,422].includes(response.status)))
        throw Object.assign(new Error('HTTP ' + response.status),{response:{status:response.status}});
      return response;
    } catch (error) {
      if (error.code && error.code.startsWith('MYNDA_TEST_')) throw error;
      const safe = problem('provider',`Live ${request.catalog ? 'catalog' : 'artwork'} request failed: ${error.code || ''} ${error.message}`);
      safe.response = error.response && {status:error.response.status,statusText:error.response.statusText};
      throw safe;
    }
  }
  const deferred = () => {let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve};};
  axios.defaults.adapter = adapter;
  return {requests,issues,begin,redact:value=>redact(value,secret),
    hold(match) {const item={match,started:deferred(),release:deferred(),used:false}; holds.push(item);
      return {started:()=>item.used,release:()=>item.release.resolve()};},
    assertHealthy() {if (issues.length) throw new Error(issues.map(item=>`${item.category}: ${item.message}`).join('\n'));},
    restore() {axios.defaults.adapter=original; holds.forEach(item=>item.release.resolve());persist();}
  };
}
module.exports = {createNetwork,redact,LIVE_LIMIT};
