const fs = require('fs');
const path = require('path');
const {parseEnv} = require('node:util');
const {configPath, validateServerConfig} = require('../src/tagging/MetadataServerConfig');

function setup(serverDirectory, identity = 'torgo') {
  if (!serverDirectory) throw new Error('Usage: npm run metadata:setup -- /path/to/mynda-server [torgo|atelaes]');
  let config;
  try {
    const values = parseEnv(fs.readFileSync(path.join(path.resolve(serverDirectory), '.dev.vars'), 'utf8'));
    const tokens = JSON.parse(values.DEV_CLIENT_TOKENS);
    config = validateServerConfig({url:'http://127.0.0.1:8787', token:tokens[identity]});
  } catch (_) {
    throw new Error('Could not read a valid development token for that identity from the server .dev.vars file. Check the directory and identity.');
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {flag:'wx', mode:0o600});
  } catch (error) {
    throw new Error(error.code === 'EEXIST' ?
      'metadata-server.local.json already exists. Rename it before running setup again.' :
      'Could not create metadata-server.local.json. Check the project directory permissions.');
  }
  console.log('Created metadata-server.local.json for http://127.0.0.1:8787. Restart Mynda to use the local server.');
  console.log('The development token was saved locally and was not printed.');
}

if (require.main === module) {
  try { setup(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = {setup};
