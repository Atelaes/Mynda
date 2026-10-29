const {app, BrowserWindow} = require('electron');

// The hidden sandbox probe is short-lived; this smoke mode exits explicitly
// after reporting all results rather than when its last window is destroyed.
app.on('window-all-closed', () => {});

async function run() {
  let result;
  try {
    const sandbox = process.env.MYNDA_REQUIRE_SANDBOX === '1'
      ? await require('./LinuxSandboxCheck').run({app, BrowserWindow}) : null;
    const MediaDependencyCheck = require('../media/MediaDependencyCheck.js');
    result = await MediaDependencyCheck.run({
      requireMpv: true,
      requireBundled: true,
      requireLgpl: true,
      requireDvd: true
    });
    if (sandbox) result.checks.sandbox = {ok: true, value: sandbox};
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
