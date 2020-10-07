
const electron = require('electron');
const path = require('path');
const fs = require('fs');
const _ = require('lodash')

class Library {
  constructor() {
    this.env = (electron.app) ? 'server' : 'browser';
    this.browser = null;
    if (this.env === 'server') {
      electron.ipcMain.on('lib-sync-op', (event, message) => {
        message.origin = event.sender;
        this.alter(message)
      });
      electron.ipcMain.on('lib-confirm', (event, message) => {
        this.getConfirm(message)
      });
      electron.ipcMain.on('lib-beacon', (event, message) => {
        this.browser = event.sender;
      });
    } else {
      ipcRenderer.on('lib-sync-op', (event, message) => {
        this.alter(message)
      });
      ipcRenderer.on('lib-confirm', (event, message) => {
        this.getConfirm(message)
      });
      ipcRenderer.send('lib-beacon');
    }

    this.dataPath = (electron.app || electron.remote.app).getPath('userData');
    this.path = path.join(this.dataPath, "Library", "library.json");

    const data = this.load();
    ['settings', 'playlists', 'collections', 'media'].map((key) => {this[key] = data[key]});

    this.Queue = [];
    this.waitConfirm = null;
    // this.lastUpdate = Date.now();
  }

  // Master changing function used by add, replace, and remove.
  //opType: the type of operation (add, replace, remove)
  //address: the location of the operation
  //entry: the item to be placed, not used in remove
  //sync, whether this was prompted by counterpart library
  alter({opType=null, address=null, entry=null, sync=false, origin=null} = {}) {
    console.log(`alter(${opType}, ${address}, ${entry}, ${sync}, ${origin})`);
    try {
      //Start with some basic validation
      if (!['add', 'replace', 'remove'].includes(opType)) {
        throw 'Unrecognized operation type.';
      } else if (['add', 'replace'].includes(opType) && !entry) {
        throw 'Add or replace operations require entry';
      } else if (opType === 'remove' && entry) {
        throw 'Remove operations should not contain an entry';
      }
      //Get one step away from the location specified by address
      //Most operations won't work if we go all the way
      let addArr = address.split('.');
      let dest = this;
      let addEnd = addArr[addArr.length-1];
      for (let i=0; i<addArr.length-1; i++) {
        dest = dest[addArr[i]];
      }
      //Figure out what we have to do and do it
      //Start with operations on an array
      //Push is used as address terminus if we're just adding to end of array
      if (Array.isArray(dest)) {
        if (addEnd === 'push') {
          switch(opType) {
            case 'add':
              dest.push(entry);
              break;
            default:
              throw "Push can only be used with add.";
          }
        } else {
          switch (opType) {
            case 'add':
              dest.splice(addEnd, 0, entry);
              break;
            case 'replace':
              dest[addEnd] = entry;
              break;
            case 'remove':
              dest.splice(addEnd, 1);
          }
        }
      } else {
        //If we're not in array, then we're in an object
        switch(opType) {
          case 'add':
            if (dest[addEnd]) {
              throw 'Something already exists at that location, use replace.';
            } else {
              dest[addEnd] = entry;
            }
            break;
          case 'replace':
            if (dest[addEnd]) {
              dest[addEnd] = entry;
            } else {
              throw 'Nothing to replace, use add.';
            }
            break;
          case 'remove':
            delete dest[addEnd];
        }
      }
      //If we haven't errored out yet, save to file, communicate with partner library
      if (sync) {
        //If this was requested by other library, let them know we did it
        this.confirm({opType: opType, address: address, entry: entry, sync: sync, origin: origin});
      } else {
        //If this was a local operation, request other library mirror it
        this.sync({opType: opType, address: address, entry: entry, sync: sync, origin: origin});
      }
      // console.log("Library.js lastUpdate before: " + this.lastUpdate);
      // this.lastUpdate = Date.now();
      // console.log("Library.js lastUpdate after: " + this.lastUpdate);
      savedPing.saved(address);

    } catch(e) {
      console.log(`Error with library alter event.  op: ${opType}, add: ${address}, ent: ${entry}, sync: ${sync}, origin: ${origin} - ${e}`);
    }
  }

  // Takes a string address in dot format, and adds "addition" to that location.
  add(address, addition) {
    this.addToQueue({opType: 'add', address: address, entry: addition, sync: false, origin: null});
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  replace(address, replacement) {
    this.addToQueue({opType: 'replace', address: address, entry: replacement, sync: false, origin: null});
  }

  // Takes a string address in dot format, and removes whatever is there.
  remove(address) {
    this.addToQueue({opType: 'remove', address: address, entry: null, sync: false, origin: null});
  }

  addToQueue(argObj) {
    if (this.waitConfirm) {
      this.Queue.push(argObj);
    } else {
      this.alter(argObj);
    }
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that a change has been made that should be mirrored.
  sync(argObj) {
    //Start by saving to file.
    this.save();
    //Next tell partner to replicate the action.
    argObj.sync = true;
    if (this.waitConfirm) {
      console.log("Trying to create confirm, but something already at waitConfirm.");
    } else {
      this.waitConfirm = argObj;
    }
    if (this.env === 'server') {
      console.log('Sending a mirror request to browser');
      this.browser.send('lib-sync-op', argObj);
    } else {
      console.log('Sending a mirror request to server');
      ipcRenderer.send('lib-sync-op', argObj);
    }
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that it has received and implemented the
  // requested change.
  confirm(argObj) {
    if (this.env === 'server') {
      let origin = argObj.origin;
      argObj.origin = null;  //This is only added on syncOps received by server.
      origin.send('lib-confirm', argObj);
    } else {
      ipcRenderer.send('lib-confirm', argObj);
    }
  }

  getConfirm(argObj) {
    if (_.isEqual(argObj, this.waitConfirm)) {
      console.log("Got a valid confirmation back!")
      this.waitConfirm = null;
      if (this.Queue.length > 0) {
        let nextOp = this.Queue.shift();
        this.alter(nextOp);
      }
    } else {
      console.log("Got a confirmation that didn't match what was expected.")
      console.log(argObj);
      console.log(this.waitConfirm);
    }
  }

  //Loads all data into an object and saves that object to file location.
  save() {
    try {
      let saveObj = {};
      ['settings', 'playlists', 'collections', 'media'].map((key) => {saveObj[key] = this[key]});
      fs.writeFileSync(this.path, JSON.stringify(saveObj));
    } catch(e) {
      console.log("Error writing to file: " + e.toString());
    }
  }

  //Loads all data from save file to object.
  load() {
    // We'll try/catch it in case the file doesn't exist yet, which will be the case on the first application run.
    // `fs.readFileSync` will return a JSON string which we then parse into a Javascript object
    try {
      return JSON.parse(fs.readFileSync(this.path));
    } catch(error) {
      // if there was some kind of error, return the passed in defaults instead.
      console.log("No file found, creating default file");
      try {
        let libDir = path.join(this.dataPath, "Library");
        let artDir = path.join(libDir, "Artwork");
        if (!fs.existsSync(libDir)) {
          fs.mkdirSync(libDir);
          fs.mkdirSync(artDir);
        }
        fs.writeFileSync(this.path, JSON.stringify(defaultLibrary));
      } catch(e) {
        console.log("Error writing to file: " + e.toString());
      }


      return defaultLibrary;
    }
  }
}

let defaultLibrary = {
  "settings" : {
    "watchfolders" : [],
    "themes" : {
      "appearances" : [
        {
          "name" : "Dark Theme",
          "path" : "../themes/appearances/dark-theme.css",
          "dependencies" : {
            "fonts" : [],
            "images" : []
          }
        }
      ],
      "layouts" : [
        {
          "name" : "Default Layout Theme",
          "path" : "../themes/layouts/default-layout-theme.css",
          "dependencies" : {}
        }
      ]
    },
    "preferences" : {
      "defaultcolumns" : {
        "used" : [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused" : [
          "kind",
          "lastseen",
          "ratings_rt",
          "ratings_imdb",
          "ratings_metacritic",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration"
        ]
      },
      "hidedescription" : false
    },
    "used" : {
      "kinds" : [
        "movie",
        "show"
      ],
      "genres" : [],
      "tags" : []
    }
  },
  "playlists" : [
    {
      "id" : 0,
      "name" : "Movies",
      "filterFunction" : "video.kind === 'movie'",
      "view" : "flat"
    },
    {
      "id" : 1,
      "name" : "Shows",
      "filterFunction" : "video.kind === 'show'",
      "view" : "hierarchical"
    }
  ],
  "collections" : [],
  "media" : []
};

// expose the class
module.exports = Library;
