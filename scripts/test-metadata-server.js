const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const serverRoot = path.resolve(process.argv[2] || path.join(root, '../mynda-server'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-server-contract-'));

try {
  const sources = {
    handleRequest:'src/api/router.ts', MetadataService:'src/metadata/service.ts', OmdbProvider:'src/providers/omdb/index.ts',
  };
  for (const file of Object.values(sources)) {
    if (!fs.existsSync(path.join(serverRoot, file))) throw new Error('Pass the mynda-server checkout path: npm run test:metadata-server -- /path/to/mynda-server');
  }
  const bundle = path.join(temporary, 'server.cjs');
  esbuild.buildSync({stdin:{contents:Object.entries(sources).map(([name, file]) =>
    `export {${name}} from ${JSON.stringify(path.join(serverRoot, file))};`).join('\n'), resolveDir:root},
    bundle:true, platform:'node', format:'cjs', outfile:bundle});
  for (const file of ['HistoricalTagging.integration.test.js', 'HistoricalMovies.integration.test.js', 'OmdbHistoricalBehaviors.integration.test.js']) {
    const result = spawnSync(process.execPath, ['--require', path.join(root, 'test/helpers/ServerContractReplay.js'), path.join(root, 'test', file)], {
      cwd:root, stdio:'inherit', env:{...process.env, MYNDA_SERVER_TEST_BUNDLE:bundle},
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, {recursive:true, force:true});
}
