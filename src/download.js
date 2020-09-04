const electron = require('electron');
const request = require('request');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');

(function() {
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

        // create the temp directory if it doesn't already exist
        // fs.mkdir(folder, (err) => {
        //   if (err) {
        //     if (err.code == 'EEXIST') return; // ignore the error if the folder already exists
        //     else return console.error(err); // something else went wrong
        //   }
        //   console.log('successfully created temp folder!');
        // });

        dest = path.join(folder, filename);
      }

      /* create an empty file to save the data */
      console.log(typeof dest);
      console.log(JSON.stringify(dest));
      const file = fs.createWriteStream(dest);
      let sendReq;
      try {
        sendReq = request.get(url);
      } catch(err) {
        return callback(err.message);
      }

      // verify response code
      sendReq.on('response', (response) => {
          if (response.statusCode !== 200) {
              return callback({status:response.statusCode});
          }

          sendReq.pipe(file);
      });

      // close() is async, call cb after close completes
      file.on('finish', () => file.close(callback({path:dest})));

      // check for request errors
      sendReq.on('error', (err) => {
          fs.unlink(dest, (errfs) => {
            if (errfs) console.log(errfs);
            else {
              console.log("Deleted file");
            }
          });
          return callback(err.message);
      });

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

    module.exports.download = (url, dest, callback) => download(url, dest, callback);
}());
