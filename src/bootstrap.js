// Keep the release-only dependency smoke test independent from normal Mynda
// startup. In particular, it must be able to diagnose packaged media tools
// even when an unrelated application module or local configuration is absent.
if (process.env.MYNDA_PACKAGED_MEDIA_SMOKE === '1') {
  require('./main/PackagedMediaSmoke.js');
} else {
  const {app, BrowserWindow} = require('electron');
  require('./main/SingleInstance.js').startSingleInstance({
    app, BrowserWindow, start: () => require('./main/index.js')
  });
}
