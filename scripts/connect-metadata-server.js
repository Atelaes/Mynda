const {validateServerConfig} = require('../src/tagging/MetadataServerConfig');
const {runCredentialCommand} = require('./metadata-credentials-cli');
async function connect(url, {execute = runCredentialCommand} = {}) {
  try { validateServerConfig({url, token:'validation-placeholder-not-a-real-token'}); }
  catch (_) { throw new Error('Use an HTTPS server origin, or HTTP on localhost, without a path, credentials, query or fragment.'); }
  const result = await execute({action:'connect', url});
  console.log(`Metadata server set to ${result.url}. Your encrypted token was preserved.`);
}
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: npm run metadata:connect -- https://your-worker.workers.dev'); process.exitCode = 1; }
  else connect(process.argv[2]).catch(error=>{console.error(error.message); process.exitCode = 1;});
}
module.exports = {connect};
