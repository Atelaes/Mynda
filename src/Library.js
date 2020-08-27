
const electron = require('electron');
const path = require('path');
const fs = require('fs');

class Library {
  constructor(opts) {
    this.env = electron.app ? 'server' : 'browser';
    const dataPath = (electron.app || electron.remote.app).getPath('userData');
    this.path = path.join(dataPath, "library.json");

    const data = this.load();
    ['settings', 'playlists', 'collections', 'media'].map((key) => {this[key] = data[key]});

    this.toDoStack = [];
    this.waitConfirm = null;
  }

  // Master changing function used by add, replace, and remove.
  //opType: the type of operation (add, replace, remove)
  //address: the location of the operation
  //entry: the item to be placed, not used in remove
  //sync, whether this was prompted by counterpart library
  alter(opType, address, entry=null, sync=false) {
    try {
      //Start with some basic validation
      if (!['add', 'replace', 'remove'].contains(opType)) {
        throw 'Unrecognized operation type.';
      } else if (['add', 'replace'].contains(opType) && !entry) {
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
              dest[addEnd].push(entry);
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
        confirm(opType, address, entry)
      } else {
        //If this was a local operation, request other library mirror it
        sync(opType, address, entry)
      }
    } catch(e) {
      console.log(`Error with library alter event.  op: ${opType}, add: ${address}, ent: ${entry} - ${e}`;
    }
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  add(address, addition) {
    this.alter('replace', address, addition);
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  replace(address, replacement) {
    this.alter('replace', address, replacement);
  }

  // Takes a string address in dot format, and removes whatever is there.
  remove(address) {
    this.alter('remove', address)
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that a change has been made.
  sync(operation, address, item = null) {
    //Start by saving to file.
    this.save();
    //Next tell partner to replicate the action.
    if (this.env === 'server') {
      win.webContents.send('lib-sync-op', [operation, address, item]);
    } else {
      ipcRenderer.send('lib-sync-op', [operation, address, item]);
    }
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that it has received and implemented the
  // requested change.
  confirm(operation, address, item = null) {
    if (this.env === 'server') {
      win.webContents.send('lib-confirm', [operation, address, item]);
    } else {
      ipcRenderer.send('lib-confirm', [operation, address, item]);
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
        fs.writeFileSync(this.path, JSON.stringify(defaultLibrary));
      } catch(e) {
        console.log("Error writing to file: " + e.toString());
      }


      return defaults;
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
    "kinds" : [
      "movie",
      "show"
    ]
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
