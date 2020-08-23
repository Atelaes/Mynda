const electron = require('electron');
const { ipcMain, dialog } = require('electron')
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const cp = require('child_process');
const ReadWrite = require("./ReadWrite.js");

app.whenReady().then(createWindow);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
        nodeIntegration: true
    }
  })
  //let userData = new ReadWrite({configName: 'userData', defaults: {}});
  console.log(app.getPath('userData'));  //userData.set('working', 'Hell yeah!');
  win.webContents.openDevTools()
  //var child = cp.spawn('ffplay', ['E:\\DVD Movies\\Moana.mp4']);

  win.loadFile('src/index.html')

}

ipcMain.on('settings-watchfolder-select', (event) => {
  let options = {properties: ['openDirectory']};
  dialog.showOpenDialog(null, options).then(result => {
  event.sender.send('settings-watchfolder-selected', result.filePaths[0]);
}).catch(err => {
  console.log(err)
})})

ipcMain.on('settings-watchfolder-add', (event, arg) => {
  console.log(arg);
})
