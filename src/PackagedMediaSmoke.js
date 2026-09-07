const {app} = require('electron');

async function run() {
  let result;
  try {
    const MediaDependencyCheck = require('./MediaDependencyCheck.js');
    result = await MediaDependencyCheck.run({
      requireMpv: true,
      requireBundled: true,
      requireLgpl: true,
      requireDvd: true
    });
  } catch(error) {
    result = {
      ok: false,
      checks: {},
      error: error && error.stack ? error.stack : String(error)
    };
  }

  process.stdout.write(`MYNDA_PACKAGED_MEDIA_SMOKE_RESULT:${JSON.stringify(result)}\n`);
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(run);
