const fs = require('fs');
const path = require('path');
const {parseEnv} = require('node:util');
const {validateServerConfig} = require('../src/tagging/MetadataServerConfig');

const {runCredentialCommand} = require('./metadata-credentials-cli');

async function setup(serverDirectory, identity = 'torgo', {execute = runCredentialCommand} = {}) {
  if (!serverDirectory) throw new Error('Usage: npm run metadata:setup -- /path/to/mynda-server [torgo|atelaes]');
  let config;
  try {
    const values = parseEnv(fs.readFileSync(path.join(path.resolve(serverDirectory), '.dev.vars'), 'utf8'));
    const tokens = JSON.parse(values.DEV_CLIENT_TOKENS);
    config = validateServerConfig({url:'http://127.0.0.1:8787', token:tokens[identity]});
  } catch (_) {
    throw new Error('Could not read a valid development token for that identity from the server .dev.vars file. Check the directory and identity.');
  }
  await execute({action:'setup', config});
  console.log('Saved the development connection in Mynda’s encrypted credential store.');
}

if (require.main === module) {
  setup(process.argv[2], process.argv[3]).catch(error=>{console.error(error.message); process.exitCode = 1;});
}

module.exports = {setup};
