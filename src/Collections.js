const Collection = require('./Collection.js');
const electron = require('electron');
// const path = require('path');
// const fs = require('fs');
const _ = require('lodash');
// const { ipcRenderer } = require('electron');

class Collections {
  constructor(collections) {
    this.c = collections
  }

  getAll(copy) {
    return copy ? _.cloneDeep(this.c) : this.c;
  }

  // finds and returns a collection object in <collectionsRoot> from its id (<id>);
  get(id) {
    // initially set collections to the root of the master collections array
    // then we'll walk down the tree using the id, which is descriptive of the tree structure
    let collections = this.c;

    // split the id into an array that we can loop over
    const map = id.split('-');

    // find the collection object by traversing the id
    let result;
    try {
      map.map((nodeIndex, index) => {
        try {
          result = collections[nodeIndex];
          if (collections[nodeIndex].collections) {
            collections = collections[nodeIndex].collections;
          }
        } catch (err) {
          throw `Could not find collection object: failed at element ${index} of ${map}. ${err}`;
        }
      });
    } catch(err) {
      console.error(err);
      // in case of error, return nothing
      return;
    }

    // return the collection
    return new Collection(result);
  }


}


// expose the class
module.exports = Collections;
