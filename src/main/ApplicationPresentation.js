'use strict';

// Keep package.name/app.getName() as "mynda": Electron uses that identity for
// the existing userData directory and macOS/Linux secure-storage key lookup.
// Only visible labels change. Other menus retain Electron's standard roles.
function installApplicationPresentation({app, Menu, platform = process.platform}) {
  app.setAboutPanelOptions({applicationName: 'Mynda'});
  if (platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: 'Mynda', submenu: [
      {role: 'about', label: 'About Mynda'}, {type: 'separator'},
      {role: 'services'}, {type: 'separator'},
      {role: 'hide', label: 'Hide Mynda'}, {role: 'hideOthers'}, {role: 'unhide'},
      {type: 'separator'}, {role: 'quit', label: 'Quit Mynda'}
    ]},
    {role: 'fileMenu'}, {role: 'editMenu'}, {role: 'viewMenu'}, {role: 'windowMenu'}
  ]));
}
module.exports = {installApplicationPresentation};
