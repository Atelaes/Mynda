const Collections = require('./Collections.js');
const electron = require('electron');
// const path = require('path');
// const fs = require('fs');
const _ = require('lodash');
// const { ipcRenderer } = require('electron');

class Collection {
  constructor(collection) {
    this.c = collection;
    this.videos = collection.videos
    this.name = collection.name
    this.id = collection.id
    this.isTerminal = this.videos ? true : false;

    this._sortVidsByOrder();
  }

  getChildren() {
    if (this.isTerminal) return;

    return new Collections(this.c.collections);
  }

  containsVideo(id) {
    if (!this.isTerminal) return false;

    return this.videos.filter(v => v.id === id).length > 0;
  }

  // index being optional;
  // in the case of a user drag-n-drop action, we want to respect the index that
  // the user dropped the video at, and adjust the order accordingly
  // (of both the video added and the subsequent videos in the array)
  addVideo(id, order, index) {
    if (!this.isTerminal) return;

    let video = {
      id:id,
      order:order
    };

    // if we don't have an order, make it 1 greater than the highest ordered video
    if (order === undefined) {
      let highest = 0;
      this.videos.map(v => {
        if (v.order > highest) {
          highest = v.order;
        }
      });
      order = highest + 1;
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
      if (this.videos[i].order <= this.videos[i-1].order) {
        this.videos[i].order = this.videos[i-1].order + 1;
      }
    }

  }

  removeVideo(id) {
    if (!this.isTerminal) return;
    let index = this._getVidIndex(id);
    if (index === -1) return false;

    // let order = this.videos[index].order;

    this.videos.splice(index,1);

    return true;
  }

  _getVidIndex(id) {
    if (!this.isTerminal) return;

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
