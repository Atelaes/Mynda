// Installed only by the disposable test bootstrap. Exercise the real Player
// component while replacing the external MPV process and its event source.
const {EventEmitter}=require('events');
const path=require('path');
const root=require('electron').remote.app.getAppPath();
const mediaTools=require(path.join(root,'src/media/MediaTools.js'));
mediaTools.mpvPath=process.execPath;
const processTools=require(path.join(root,'src/media/MpvProcess.js'));
const playback={player:null,loads:[],resumes:[]};
class FixturePlayer extends EventEmitter {
  constructor() {super();playback.player=this;}
  async load(filename) {playback.loads.push(filename);}
  async goToPosition(position) {playback.resumes.push(position);}
  async addSubtitles() {}
  async play() {}
}
const mpvModule=require.resolve('node-mpv');
require(mpvModule);
require.cache[mpvModule].exports=FixturePlayer;
processTools.startMpvPlayer=async()=>{};
processTools.stopMpvPlayer=()=>{};
window.__myndaJourneyPlayback=playback;
window.alert=message=>{throw new Error('Unexpected app alert: '+message);};
