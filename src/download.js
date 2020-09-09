const electron = require('electron');
// const request = require('request');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');

(function() {
    let source;
    const download = (url, dest, callback) => {
      // if no destination path is sent, use a default temp folder with a random filename
      if (dest === '' || typeof dest !== 'string') {

        let ext = '';
        try {
          ext = url.match(/\.\w{3,4}$/g).pop();
        } catch(err) {
          console.log(err);
        }
        let filename = uuidv4() + ext;
        let folder = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');

        dest = path.join(folder, filename);
      }

      /* create an empty file to save the data */
      console.log(typeof dest);
      console.log(JSON.stringify(dest));
      const file = fs.createWriteStream(dest);
      source = axios.CancelToken.source();

      axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: 30000,
        cancelToken: source.token
      })
        .then(function (response) {
          if (response.status !== 200) {
            return callback(response.status + ': ' + response.statusText);
          }

          // pipe data to file
          response.data.pipe(file);
        })
        .catch(function (error) {
          // delete file
          fs.unlink(dest, (errfs) => {
            if (errfs) console.log(errfs);
            else {
              console.log("Deleted file");
            }
          });
          return callback(error.message);
        })
        .then(function () {
          // always executed
        });

      // close() is async, call cb after close completes
      file.on('finish', () => file.close(callback({path:dest})));

      file.on('error', (err) => { // Handle errors
          fs.unlink(dest, (errfs) => {
            if (errfs) console.log(errfs);
            else {
              console.log("Deleted file");
            }
          });
          return callback(err.message);
      });

    };
    // module.exports.canceller = () => { source.cancel("Download Cancelled!!!"); }
    module.exports.download = (url, dest, callback) => download(url, dest, callback);
}());
