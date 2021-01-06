const Collections = require('./Collections.js');
const electron = require('electron');
// const path = require('path');
// const fs = require('fs');
const _ = require('lodash');
// const { ipcRenderer } = require('electron');

class Collection {
  constructor(collection) {
    this.c = collection;
    this.videos = collection.videos;
    this.name = collection.name;
    this.id = collection.id;
    this.isTerminal = this.videos ? true : false;

    this._sortVidsByOrder();
  }

  // change the id of this collection;
  // id's are descriptive of the collections structure, e.g. the second child
  // of the first child of the 3rd top-level collection will have the id '2-0-1'
  // when we delete or add a new collection, we may need to alter the ids of other
  // collections to preserve this descriptive property;
  // the 'depth' parameter is like an index of which depth to alter in the id;
  // for instance, a value of 1 would indicate that we should change the second
  // number in the id (in our example, the 0); the 'value' parameter is what to change it to;
  // in addition to that, we need to do the same alteration to all of this collections
  // children, grandchildren, etc., so we simply call the same function recursively
  changeID(depth,value) {
    let arrayID = this.c.id.split('-');
    arrayID[depth] = value;
    this.c.id = arrayID.join('-');

    if (this.c.collections) {
      this.c.collections.map(c => {
        let col = new Collection(c);
        col.changeID(depth,value);
      });
    }
  }


  // ---------------------------------- //
  // ---------- METHODS FOR ----------- //
  // ---- NON-TERMINAL COLLECTIONS ---- //
  // ---------------------------------- //


  getChildren() {
    if (this.isTerminal) return;

    if (this.c.collections) {
      return this.c.collections;
    } else {
      return null;
    }
  }

  addChild(name) {
    if (this.isTerminal) return;

    console.log(`Adding child to '${this.name}'`);

    if (!this.c.collections) {
      this.c.collections = [];
    }

    this.c.collections.push({
      id : `${this.id}-${this.c.collections.length}`,
      name : name || ''
    });

    return new Collection(this.c.collections[this.c.collections.length-1]);
  }

  // only removes an immediate child
  // (though that obviously includes all the descendants of that child)
  // decrements the ID's of all the collections following the deleted child
  removeChild(id) {
    if (this.isTerminal) return;

    // this.c.collections = this.c.collections.filter(c => c.id !== id);
    let temp = [];
    let afterFlag = false;
    for (let i=0; i < this.c.collections.length; i++) {
      let col = new Collection(_.cloneDeep(this.c.collections[i]));
      if (col.id !== id) {
        if (afterFlag) {
          let idArray = col.id.split('-');
          let depth = idArray.length - 1;
          console.log('idArray: ' + idArray)
          console.log('depth: ' + depth);
          console.log('value: ' + (idArray[depth] - 1));
          col.changeID(depth,idArray[depth] - 1);
        }
        temp.push(col.c);
      } else {
        afterFlag = true;
      }
    }
    if (temp.length > 0) {
      this.c.collections = temp;
    } else {
      delete this.c.collections;
    }
  }

  // -------------------------------- //
  // --------- METHODS FOR ---------- //
  // ----- TERMINAL COLLECTIONS ----- //
  // -------------------------------- //


  containsVideo(id) {
    if (!this.isTerminal) return false;

    return this.videos.filter(v => v.id === id).length > 0;
  }

  getVidOrder(id) {
    if (!this.isTerminal) return;

    try {
      return this.videos.filter(v => v.id === id)[0].order;
    } catch(err) {
      console.log(`Collections.getVidOrder failed on ${id}: ${err}`);
      return;
    }
  }

  // id is the video id
  updateOrder(id, order) {
    if (!this.isTerminal) return;

    try {
      // this.videos.filter(v => v.id === id)[0].order = order;
      if (this.removeVideo(id)) {
        return this.addVideo(id, order);
      }
    } catch(err) {
      console.log(`Collections.updateOrder failed on ${id}: ${err}`);
      return;
    }
    return false;
  }


  // index being optional;
  // in the case of a user drag-n-drop action, we want to respect the index that
  // the user dropped the video at, and adjust the order accordingly
  // (of both the video added and the subsequent videos in the array)
  addVideo(id, order, index) {
    if (!this.isTerminal) {
      // if this has child collections, then it cannot become a terminal collection
      // and so we cannot add a video
      if (this.c.collections) {
        return;
      } else {
        // if it does not have child collections, then we can convert it to a terminal collection
        // creating a videos array, and marking it as terminal
        this.c.videos = [];
        this.videos = this.c.videos;
        this.isTerminal = true;
      }
    }

    if (order) {
      order = Math.round(Number(order) * 10) / 10;
    }

    // if we don't have an order, make it (an integer) 1 greater than the highest ordered video
    if (order === undefined) {
      let highest = 0;
      this.videos.map(v => {
        if (v.order > highest) {
          highest = v.order;
        }
      });
      order = Math.floor(highest + 1);
    }

    let video = {
      id:id,
      order:order
    };

    // if we don't have an index, find one based on order
    if (index === undefined) {
      index = this.videos.length;
      for (let i=0; i<this.videos.length; i++) {
        if (this.videos[i].order > order) {
          index = i;
          break;
        }
      }
    }

    // place the video at the index
    this.videos.splice(index,0,video);

    // now loop through all the *subsequent* videos and adjust their order property
    // if necessary
    for (let i=index+1; i<this.videos.length; i++) {
      while (this.videos[i].order <= this.videos[i-1].order) {
        // if the order of the latter video is an integer
        if (this.videos[i].order === Math.floor(this.videos[i].order)) {
          console.log("this vid (integer): " + this.videos[i].order);
          console.log("prev vid: " + this.videos[i-1].order);
          // we want to keep it as an integer,
          // so set it to the next greatest integer after the previous video
          // e.g.  #1: 5.4      #1: 5.4
          //       #2: 2    =>  #2: 6
          this.videos[i].order = Math.floor(this.videos[i-1].order) + 1;
        }
        // if the order of the latter video is NOT an integer, we want to preserve
        // the decimal part of the order (or increment it if necessary)
        else {
          console.log("this vid (decimal): " + this.videos[i].order);
          console.log("prev vid: " + this.videos[i-1].order);
          // if the integer part of the latter is less than the former, set the
          // integer part to 1 greater than the former, preserving the decimal part
          // e.g.  #1: 3          #1: 3
          //       #2: 2.1  =>    #2: 4.1
          if (Math.floor(this.videos[i].order) < Math.floor(this.videos[i-1].order)) {
            console.log("integer part is smaller");
            this.videos[i].order += Math.floor(this.videos[i-1].order) - Math.floor(this.videos[i].order) + 1;
          }
          // if the integer part of the latter is the same as the former, set the
          // increment the decimal part
          // e.g.  #1: 2.5        #1: 2.5
          //       #2: 2.1  =>    #2: 2.2 (eventually reaching 2.6)
          else if (Math.floor(this.videos[i].order) === Math.floor(this.videos[i-1].order)) {
            console.log("integer part is equal");
            this.videos[i].order += .1;
          }
        }
        console.log('new value: ' + this.videos[i].order);
      }
      // round to fix any goofy floating point issues
      this.videos[i].order = Math.round(this.videos[i].order * 10) / 10;
    }

    return true;
  }

  removeVideo(id) {
    if (!this.isTerminal) return;
    let index = this._getVidIndex(id);
    console.log("index: " + index);
    if (index === -1) return false;

    // let order = this.videos[index].order;

    this.videos.splice(index,1);

    if (this.videos.length === 0) {
      this.convertToNonTerminal();
    }

    return true;
  }

  convertToNonTerminal() {
    console.log(`Converting '${this.name}' to non-terminal`)
    delete this.c.videos;
    delete this.videos;
    this.isTerminal = false;
  }

  // ------------------------------

  _getVidIndex(id) {
    if (!this.isTerminal) return -1;
    // console.log('id: ' + id);
    // console.log('videos: ' + JSON.stringify(this.videos));

    for (let i=0; i<this.videos.length; i++) {
      if (this.videos[i].id === id) {
        return i;
      }
    }

    return -1;
  }

  _sortVidsByOrder() {
    if (!this.isTerminal) return;

    return this.videos.sort((a,b) => a.order > b.order ? 1 : (a.order == b.order ? 0 : -1));
  }
}


// expose the class
module.exports = Collection;
