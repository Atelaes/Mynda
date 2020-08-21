const electron = require('electron');
const { ipcMain, dialog } = require('electron')
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const cp = require('child_process');
const ReadWrite = require("./ReadWrite.js");

app.whenReady().then(createWindow);

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
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

ipcMain.on('select-watchfolder', (event) => {
  console.log('watchfolder method fired!')
  let options = {properties: ['openDirectory']};
  dialog.showOpenDialog(null, options).then(result => {
  console.log(result.canceled)
  console.log(result.filePaths)
}).catch(err => {
  console.log(err)
})})
