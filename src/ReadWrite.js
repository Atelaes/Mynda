
const electron = require('electron');
const path = require('path');
const fs = require('fs');
const Logger = require('./Logger.js');

const log = Logger.child('ReadWrite');

class ReadWrite {
  constructor(opts) {
    // Renderer process has to get `app` module via `remote`, whereas the main process can get it directly
    // app.getPath('userData') will return a string of the user's app data directory path.
    const userDataPath = (electron.app || electron.remote.app).getPath('userData');
    // We'll use the `configName` property to set the file name and path.join to bring it all together as a string
    this.path = path.join(userDataPath, opts.configName + '.' + opts.extension);
    log.debug('Read/write data path configured', {path: this.path});

    this.data = this._parseDataFile(this.path, opts.defaults);
  }

  // This will just return the property on the `data` object
  get(key) {
    return this.data[key];
  }

  // ...and this will set it
  set(key, val) {
    this.data[key] = val;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data));
    } catch(e) {
      log.error('Could not write data file', {
        path: this.path,
        error: e
      });
    }
  }

  _parseDataFile(filePath, defaults) {
    // We'll try/catch it in case the file doesn't exist yet, which will be the case on the first application run.
    // `fs.readFileSync` will return a JSON string which we then parse into a Javascript object
    try {
      return JSON.parse(fs.readFileSync(filePath));
    } catch(error) {
      // if there was some kind of error, return the passed in defaults instead.
      if (error && error.code === 'ENOENT') {
        log.info('Data file was not found; creating it from defaults', {path: filePath});
      } else {
        log.warn('Could not read data file; replacing it with defaults', {
          path: filePath,
          error: error
        });
      }

      // Object.keys(defaults).forEach((key) => {
      //   this.set(key, defaults[key]);
      // });
      try {
        fs.writeFileSync(this.path, JSON.stringify(defaults));
      } catch(e) {
        log.error('Could not write default data file', {
          path: this.path,
          error: e
        });
      }


      return defaults;
    }
  }
}

// expose the class
module.exports = ReadWrite;
