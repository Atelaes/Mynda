// Renderer bootstrap. Babel's require hook is installed by index.html before
// this file is loaded, so JSX in the required renderer modules is transpiled too.

// Preserve the monolith's dependency-loading and FFmpeg setup order during
// this structural refactor. Each extracted module also imports its own explicit
// dependencies, and this compatibility block can be pared down separately.

const React = require('react');
const ReactDOM = require('react-dom');
const electron = require('electron');
const { ipcRenderer } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const _ = require('lodash');
const DateJS = require('datejs');
const URL = require("url");
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const Logger = require('./Logger.js');
const OmdbHelper = require('./OmdbHelper.js');
const omdb = require('../omdb');
const axios = require('axios');
const accounting = require('accounting');
const { DragDropContext, Droppable, Draggable } = require('react-beautiful-dnd');
const hashObject = require('object-hash');
const Hls = require('hls.js');
const Stream = require('./Stream.js');
const subtitle = require('subtitle');
const crypto = require('crypto');
const mpvAPI = require('node-mpv');
const pathToFFmpeg = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(pathToFFmpeg);
const ffprobe = require('ffprobe');
const frontendLog = Logger.child('Renderer');
const libraryViewLog = Logger.child('LibraryView');
const playerLog = Logger.child('Player');
const settingsLog = Logger.child('Settings');
const editorLog = Logger.child('Editor');
const artworkLog = Logger.child('Artwork');
let ffprobeStatic = {};
try {
  ffprobeStatic = require('ffprobe-static');
} catch(err) {
  frontendLog.warn('ffprobe-static is unavailable in the renderer', {error: err});
}

const {library} = require('./renderer/RendererRuntime.js');

const {Mynda} = require('./renderer/Mynda.js');

ReactDOM.render(<Mynda library={library}/>, document.getElementById('root'));
