const electron = require('electron');
// const request = require('request');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');

(function() {
  let source;

  const download = (url, dest, callback) => {
    let completed = false;
    const complete = result => {
      if (!completed) {
        completed = true;
        callback(result);
      }
    };
    const failureDetails = error => ({
      message: error && error.message ? error.message : String(error || 'Download failed'),
      status: error && error.response && error.response.status,
      statusText: error && error.response && error.response.statusText
    });

    console.log(`download.js started, with destination: ${dest}`);
    // If no destination path is sent, use a default temp folder with a random filename.
    if (dest === '' || typeof dest !== 'string') {
      console.log('download.js did not receive a destination for the downloaded file.');
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

    // Create an empty file to save the data.
    console.log(typeof dest);
    console.log(JSON.stringify(dest));
    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch(error) {
      complete(failureDetails(error));
      return;
    }

    const removePartialFile = () => {
      fs.unlink(dest, error => {
        if (error && error.code !== 'ENOENT') {
          console.log(error);
        }
      });
    };

    source = axios.CancelToken.source();
    axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 30000,
      cancelToken: source.token
    })
      .then(response => {
        if (response.status !== 200) {
          file.destroy();
          removePartialFile();
          complete({
            message: response.status + ': ' + response.statusText,
            status: response.status,
            statusText: response.statusText
          });
          return;
        }

        response.data.pipe(file);
      })
      .catch(error => {
        file.destroy();
        removePartialFile();
        complete(failureDetails(error));
      });

    // close() is async; report success only after the file has closed.
    file.on('finish', () => file.close(error => {
      if (error) {
        removePartialFile();
        complete(failureDetails(error));
      } else {
        complete({path: dest});
      }
    }));

    file.on('error', error => {
      removePartialFile();
      complete(failureDetails(error));
    });
  };

  // module.exports.canceller = () => { source.cancel("Download Cancelled!!!"); }
  module.exports.download = (url, dest, callback) => download(url, dest, callback);
}());
