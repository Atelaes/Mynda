const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../../metadata-server.local.json');
const defaultServerURL = 'https://mynda-server-dev.torvor-dev.workers.dev';
const configurationMessage = 'Open Settings → License to activate Mynda or check its activation.';

function validateServerConfig(value) {
  const invalid = () => { throw new Error(configurationMessage); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (typeof value.url !== 'string' || value.url.length > 2048 || !/^https?:\/\//.test(value.url)) return invalid();
  let url;
  try { url = new URL(value.url); } catch (_) { return invalid(); }
  // Hosted development uses TLS. Plain HTTP remains available only for local
  // Wrangler; credentials are never sent to a remote HTTP endpoint.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token)) return invalid();
  return {url: url.origin, token: value.token};
}

function loadMetadataServerConfig({file = configPath, readFile = fs.readFileSync} = {}) {
  try {
    return validateServerConfig(JSON.parse(readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Missing or broken settings must not prevent the app opening. Report the
    // problem on the next lookup; metadata always goes through the server.
    return {configurationError: true};
  }
}

module.exports = {configPath, defaultServerURL, configurationMessage, validateServerConfig, loadMetadataServerConfig};
