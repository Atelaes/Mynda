const electron = require('electron');
// const request = require('request');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Logger = require('./Logger.js');

const log = Logger.child('Download');

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

    log.debug('Download started', {
      destinationProvided: typeof dest === 'string' && dest !== '',
      destination: typeof dest === 'string' ? dest : undefined
    });
    // If no destination path is sent, use a default temp folder with a random filename.
    if (dest === '' || typeof dest !== 'string') {
      log.debug('Download did not include a destination; creating a temporary filename');
      let ext = '';
      try {
        ext = url.match(/\.\w{3,4}$/g).pop();
      } catch(err) {
        log.debug('Could not derive an extension for the temporary download filename', {
          error: err
        });
      }
      let filename = uuidv4() + ext;
      let folder = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');
      dest = path.join(folder, filename);
    }

    // Create an empty file to save the data.
    log.debug('Opening download destination', {destination: dest});
    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch(error) {
      log.error('Could not create download destination', {
        destination: dest,
        error: error
      });
      complete(failureDetails(error));
      return;
    }

    const removePartialFile = () => {
      fs.unlink(dest, error => {
        if (error && error.code !== 'ENOENT') {
          log.warn('Could not remove a partial download', {
            destination: dest,
            error: error
          });
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
          log.warn('Download returned a non-success status', {
            destination: dest,
            status: response.status,
            statusText: response.statusText
          });
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
        const canceled = typeof axios.isCancel === 'function' && axios.isCancel(error);
        log[canceled ? 'debug' : 'warn'](canceled ?
          'Download canceled' : 'Download request failed', {
            destination: dest,
            error: error
          });
        file.destroy();
        removePartialFile();
        complete(failureDetails(error));
      });

    // close() is async; report success only after the file has closed.
    file.on('finish', () => file.close(error => {
      if (error) {
        log.error('Could not close completed download', {
          destination: dest,
          error: error
        });
        removePartialFile();
        complete(failureDetails(error));
      } else {
        log.debug('Download finished', {destination: dest});
        complete({path: dest});
      }
    }));

    file.on('error', error => {
      log.error('Could not write download', {
        destination: dest,
        error: error
      });
      removePartialFile();
      complete(failureDetails(error));
    });
  };

  // module.exports.canceller = () => { source.cancel("Download Cancelled!!!"); }
  module.exports.download = (url, dest, callback) => download(url, dest, callback);
}());
