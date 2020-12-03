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
    this.collections = collection.collections;// ? new Collections(collection.collections) : undefined;
    this.name = collection.name;
    this.id = collection.id;
    this.isTerminal = this.videos ? true : false;

    this._sortVidsByOrder();
  }

  getChildren() {
    if (this.isTerminal) return;

    if (this.collections) {
      return this.collections;
    } else {
      return null;
    }
  }

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
    if (!this.isTerminal) return;

    if (order) {
      order = Math.round(Number(order) * 10) / 10;
    }

    let video = {
      id:id,
      order:order
    };

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
          console.log("integer: " + this.videos[i].order);
          // we want to keep it as an integer,
          // so set it to the next greatest integer after the previous video
          // e.g.  #1: 5.4      #1: 5.4
          //       #2: 2    =>  #2: 6
          this.videos[i].order = Math.floor(this.videos[i-1].order) + 1;
        }
        // if the order of the latter video is NOT an integer, we want to preserve
        // the decimal part of the order (or increment it if necessary)
        else {
          console.log("decimal: " + this.videos[i].order)
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

    return true;
  }

  _getVidIndex(id) {
    if (!this.isTerminal) return;
    console.log('id: ' + id);
    console.log('videos: ' + JSON.stringify(this.videos));

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
