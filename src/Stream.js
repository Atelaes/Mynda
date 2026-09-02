
const electron = require('electron');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const Logger = require('./Logger.js');
// const { ipcRenderer } = require('electron');
const ffmpeg = require('fluent-ffmpeg');
const HLSServer = require('hls-server');
const http = require('http');
const streamLog = Logger.child('Stream');
let server;


class Stream {
  constructor() {
    this.command = ffmpeg();


    // server = http.createServer();
    // this.hls = new HLSServer(server, {
    //   path: '/streams',     // Base URI to output HLS streams
    //   dir: '/Users/torgo/Documents/Coding/Mynda/video_stream'  // Directory that input files are stored
    // });
    // server.listen(8000, err => {
    //   if (err) {
    //     console.log("SERVER ERROR! Oh bollocks!");
    //     console.error(err);
    //   }
    // });
    //
    // console.log(this.hls);
    // console.log(JSON.stringify(this.hls));
  }

  createStream(source,video_id,callbacks) {
    const outputPath = `video_stream/${video_id}.m3u8`;
    // const size = fs.statSync(source).size;

    // Below is FFMPEG converting MP4 to HLS with reasonable options.
    // https://www.ffmpeg.org/ffmpeg-formats.html#hls-2
    this.command.input(source);
    this.command.output(outputPath).setDuration(60);
    this.command.addOptions([
        // '-profile:v baseline',    // baseline profile (level 3.0) for H264 video codec
        // '-level 3.0',
        // '-s 1280x720',            // 640px width, 360px height output video dimensions
        '-start_number 0',        // start the first .ts segment at index 0
        '-hls_time 4',            // segment target duration in seconds - the actual length is constrained by key frames
        '-g 48',
        '-keyint_min 48',         // create key frame (I-frame) every 48 frames (~2 seconds) - will later affect correct slicing of segments and alignment of renditions
        '-hls_list_size 0',       // Maxmimum number of playlist entries (0 means all entries/infinite)
        // '-hls_playlist_type vod',  // adds the #EXT-X-PLAYLIST-TYPE:VOD tag and keeps all segments in the playlist
        '-f hls'                  // HLS format
        // 'headers "Content-Range: bytes */92000000"'
      ]);
    this.command.on('codecData', (data) => {
        streamLog.debug('FFmpeg stream codec data received', {
          source: source,
          videoID: video_id,
          codecData: data
        });
        if (callbacks && _.isFunction(callbacks.codecData)) {
          streamLog.debug('Calling stream codec-data callback', {
            videoID: video_id
          });
          callbacks.codecData(outputPath,data);
        }
      }).on('progress', () => {
        if (callbacks && _.isFunction(callbacks.progress)) {
          streamLog.debug('Calling stream progress callback', {
            videoID: video_id
          });
          callbacks.progress(outputPath);
        }
      }).on('error', (err) => {
        if (err) {
          streamLog.error('FFmpeg stream failed', {
            source: source,
            videoID: video_id,
            error: err
          });
        }
        if (callbacks && _.isFunction(callbacks.error)) {
          streamLog.debug('Calling stream error callback', {
            videoID: video_id
          });
          callbacks.error(err);
        }
      }).on('end', () => {
        // callback
        streamLog.info('FFmpeg stream ended', {
          source: source,
          videoID: video_id,
          outputPath: outputPath
        });
      });

    this.command.run();

    // // Kill ffmpeg after 60 seconds
    // setTimeout(() => {
    //   console.log('killing');
    //   this.command.kill();
    // }, 60000);
  }

  // seek(seconds) {
  //   console.log(`Seeking ffmpeg process to ${seconds} seconds...`);
  //   // this.command.kill('SIGSTOP');
  //   this.command.seekInput(seconds);
  //   // this.command.run();
  //   // this.command.kill('SIGCONT');
  // }

  kill() {
    streamLog.debug('Stopping FFmpeg stream process');
    this.command.kill();
  }


}


// expose the class
module.exports = Stream;
