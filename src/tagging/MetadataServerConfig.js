const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../../metadata-server.local.json');
const configurationMessage = 'Metadata server configuration is invalid. Check metadata-server.local.json and restart Mynda.';

function validateServerConfig(value) {
  const invalid = () => { throw new Error(configurationMessage); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  let url;
  try { url = new URL(value.url); } catch (_) { return invalid(); }
  // This milestone is deliberately local. Remote service configuration follows
  // deployment, shared usage controls, and production authentication.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) return invalid();
  return {url: url.origin, token: value.token};
}

function loadMetadataServerConfig({file = configPath, readFile = fs.readFileSync} = {}) {
  try {
    return validateServerConfig(JSON.parse(readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // A broken opt-in config must neither prevent the app opening nor silently
    // send requests directly to OMDb. Report the problem on the next lookup.
    return {configurationError: true};
  }
}

module.exports = {configPath, configurationMessage, validateServerConfig, loadMetadataServerConfig};
