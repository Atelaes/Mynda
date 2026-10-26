'use strict';

// Electron reads the top-level productName before loading our main process.
// Its standard application menu and profile/credential identity are now Mynda.
function installApplicationPresentation({app}) {
  app.setAboutPanelOptions({applicationName: 'Mynda'});
}
module.exports = {installApplicationPresentation};
