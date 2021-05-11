const path = require('path');
const omdb = require('../omdb');
const axios = require('axios');
const _ = require('lodash');
const accounting = require('accounting');
const fs = require('fs');
const electron = require('electron');
const dl = require('./download');
const { ipcRenderer } = require('electron');

//Takes a video object with optional parameters (file is required)
//and returns an array of results or false if none were found
async function search(video) {
  //start by pulling and formatting useful information
  //persisting is the information organized for quick access and modification
  let persisting = extractParts(video);
  //console.log(persisting);
  //urlParts is a joinable array formatted for url
  let urlParts = createURLParts(persisting);
  //console.log(urlParts);
  //Now that we have everything formatted, enter an infinite loop.
  //Each pass of the loop we poll the database.
  //If we get no response modify the search parameters.
  //Loop is broken by a return following one of three conditions:
  // 1. We got results from OMDB
  // 2. We've exhausted all options and give up
  // 3. We got an error
  let returnObject = {sucess: false};
  //In the case of a show, if we don't have the requisite data,
  //then we've failed right off the bat, give up now.
  if (Object.keys(persisting).length === 0) {
    returnObject.failure = 'Not enough data';
    return returnObject;
  }
  while (true) {
    try {
      let response = await pollOMDB(urlParts);
      //console.log(`pollOMDB response is ${JSON.stringify(response)}.`)
      if (response.Error) {
        //console.log(response.Error);
        returnObject.failure = 'Error';
        returnObject.data = response.Error;
        return returnObject;
      } else if (response.status !== 200) {
        //console.log(response.status + ': ' + response.statusText);
        returnObject.failure = response.status;
        returnObject.data = response.statusText;
        return returnObject;
      } else if (response.data.Response === 'True') {
        //If "Search", then it's an array of movie(s) with minimal info
        if (response.data.Search) {
          returnObject.success = true;
          returnObject.data = response.data.Search;
          return returnObject;
        } else {
          //If not, then we have a single entry with full info
          //Format the new info, merge it into the given video object, and return.
          video = incorporateMetaData(video, response.data);
          if (video.artwork && video.artwork !== 'N/A') {
            try {
              video.artwork = await downloadArt(video.artwork) || video.artwork;
            } catch(e) {
              console.log(e);
            }
          }
          returnObject.success = true;
          returnObject.data = video;
          return returnObject;
        }

      } else if (persisting.title && persisting.title.split(/[\.-–—_,;/\\\s]/).length > 1) {
        // try some modifications on the title
        //console.log('nothing found, trying again with modifications');

        if (/\./.test(persisting.title)) {
          // if there are periods, replace them all with spaces
          persisting.title = persisting.title.replace(/\.+/g,' ');
        } else if (/[-–—_,;/\\]/.test(persisting.title)) {
          // if that didn't work,
          // replace most other punctuation with spaces
          // and try again
          persisting.title = persisting.title.replace(/[-–—_,;/\\]+/g,' ');
        } else {
          // if that didn't work, start lopping off the last word
          // (and recursing until we find some results)
          persisting.title = persisting.title.split(/\s/).slice(0,-1).join(' ');
        }
        urlParts = createURLParts(persisting);
      } else {
        //console.log(`Did not find any results, giving up.`);
        returnObject.failure = 'No results';
        return returnObject;
      }
    } catch (e) {
      //console.log(e);
      returnObject.failure = 'Error';
      returnObject.data = e;
      return false;
    }
  }
}

//Find and format needed information for search.
function extractParts(video) {
  let persisting = {};
  // first check to see if an IMDb ID exists
  if (video.imdbID && video.imdbID !== '') {
    // if they have, then we add that to the search
    persisting.id = video.imdbID;
  } else if (video.kind === 'show') {
    //Movies are kind of flexible, but shows are not
    //If we don't have all the necessary info, we can't do the search.
    if (video.series && video.season && video.episode) {
      persisting.series = video.series;
      persisting.season = video.season;
      persisting.episode = video.episode;
    }
  } else {
    // otherwise, we want to query the database using the existing field values
    // of the movie object, if present; OMDB only allows us to search by Title,
    // Year, and Type;
    // if the title field is empty, we will substitute the file name
    // const filename = this.props.video.filename.match(/[^/]+$/)[0]; // get just the filename from the path // /[^/]+(?=\.\w{2,4}$)/
    let filename = path.basename(video.filename,path.extname(video.filename));
    //console.log('filename: ' + filename);
    persisting.title = video.title || filename;
    persisting.year = video.year || null;
    let typeConversion = {movie: 'movie', show: 'episode', episode: 'episode', series: 'series'}
    if (video.type && typeConversion[video.type]) {
      persisting.type = typeConversion[video.type];
    }

    // if we have no year, see if a year-like string is in the file name or title
    if (persisting.year === null) {
      let str = persisting.title
      // find any 4 digit strings starting with 19 or 20
      let results = str.match(/(?:19|20)\d{2}/g);
      try {
        // filter the results for years no more than 1 in the future
        results = results.filter(el => {
          return Number(el) <= Number(new Date().getFullYear()) + 1;
        });

        // for now, just pick the first one
        if (results[0]) {
          persisting.year = results[0];
        }
      } catch(err) {
        // there were no results, so we do nothing
      }
    }
  }
  return persisting;
}

function createURLParts(persisting) {
  let urlParts = [`http://www.omdbapi.com/?apikey=${omdb.key}`];
  let possibleParts = ['id', 'title', 'year', 'type', 'series', 'season', 'episode'];
  let prefixes = {id: 'i', title: 's', year: 'y', type: 'type', series: 't', season: 'season', episode: 'episode'};
  for (let part of possibleParts) {
    if (persisting[part]) {
      urlParts.push(`${prefixes[part]}=${persisting[part]}`);
    }
  }
  return urlParts;
}

function pollOMDB(urlParts) {
  return new Promise(function(resolve, reject) {
    //console.log(`Url we're using is ${urlParts.join('&')}`)
    axios({
      method: 'get',
      url: urlParts.join('&'),
      timeout: 20000,
    })
      .then((response) => {
        //console.log('Got a response');
        //console.log(urlParts.join('&'));
        resolve(response);
      })
      .catch((error) => {
        console.log('Got an error');
        console.log(error);
        reject({Error:error});
      })
    })
}

function incorporateMetaData(video, data) {
  //console.log(JSON.stringify(video));
  video.imdbID = data.imdbID;
  video.title = data.Title;
  delete video.Title;
  video.description = data.Plot;
  video.artwork = data.Poster, // the MynEditArtwork component will do the work to actually download the image from this url and change the reference to the local file when finished
  delete video.Poster;
  video.year = data.Year;
  delete video.Year;
  video.director = data.Director,
  video.kind = data.Type === 'episode' ? 'show' : data.Type;
  delete video.Type;
  video.country = data.Country;
  video.rated = data.Rated;
  try {
    video.boxoffice = accounting.parse(data.BoxOffice) || 0; //parseInt(response.data.BoxOffice.replace(/[^0-9.-]/g,'')) || null, // this may fail miserably in other locales, but assuming OMDB always uses $0,000,000.00 format, it'll be fine
  } catch(err) { console.error(`OMDB parse boxoffice: ${err}`); }
  try {
    video.directorsort = /^\w+\s\w+$/.test(data.Director) ? data.Director.replace(/^(\w+)\s(\w+)$/,($match,$1,$2) => `${$2}, ${$1}`) : data.Director; // if the director field consists only of a first and last name separated by a space, set directorsort to 'lastname, firstname', otherwise, leave as-is and let the user edit it manually
  } catch(err) { console.error(`OMDB parse directorsort: ${err}`); }
  try {
    video.cast = data.Actors.split(', ');
  } catch(err) { console.error(`OMDB parse actors: ${err}`); }
  try {
    video.genre = data.Genre.split(', ')[0]; // just pick the first genre for genre, since we only allow one
  } catch(err) { console.error(`OMDB parse genre: ${err}`); }
  try {
    video.languages = data.Language.split(', ');
  } catch(err) { console.error(`OMDB parse languages: ${err}`); }
  try {
    video.tags = video.tags || [];
    video.tags = Array.from(new Set(data.Genre.split(', ').map((item) => item.toLowerCase()).concat(video.tags))); // add new tags to existing tags, removing duplicates
  } catch(err) { console.error(`OMDB parse tags: ${err}`); }
  let ratings = _.cloneDeep(video.ratings) || {};
  try {
    ratings.imdb = Number(data.Ratings.filter(object => object.Source == "Internet Movie Database")[0].Value.match(/^[\d\.]+(?=\/)/)); // / 10;
  } catch(err) { console.error(`OMDB parse imdb rating: ${err}`); }
  try {
    ratings.rt = Number(data.Ratings.filter(object => object.Source == "Rotten Tomatoes")[0].Value.match(/^\d+/)); // / 100;
  } catch(err) { console.error(`OMDB parse rt rating: ${err}`); }
  try {
    ratings.mc = Number(data.Ratings.filter(object => object.Source == "Metacritic")[0].Value.match(/^\d+(?=\/)/)); // / 100;
  } catch(err) { console.error(`OMDB parse mc rating: ${err}`); }
  video.ratings = ratings;
  return video;
}

function downloadArt(url) {
  return new Promise(function(resolve, reject) {
    let fileExt = path.extname(url)
    let fileName = path.basename(url, fileExt);
    fileName = fileName.replaceAll(/[\*\."/\\\[\]:;\|,]/g, '') + fileExt;
    let filePath = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork', fileName);
    if (fs.existsSync(filePath)) {
      resolve(filePath);
    }

    if (electron.app) {
      let response = {success:false, message:''};
      dl.download(url,filePath, (args) => {
        try {
          // if successful, we'll receive an object with the path at "path"
          if (args.hasOwnProperty('path')) {
            response.success = true;
            response.message = args.path;
            resolve(args.path);
            // console.log("successfully downloaded file");
          } else {
            // console.log(JSON.stringify(args));
            response.success = false;
            response.message = args;
            reject(response);
          }
        } catch(error) {
          response.success = false;
          response.message = error;
          reject(response);
          // console.log(error);
        }
      });
    } else {
      ipcRenderer.on('downloaded', (event, response) => {
        if (response.success) {
          console.log('Successfully downloaded artwork');
          resolve(filePath);
        } else {
          console.log("Unable to download file: " + response.message);
          reject();
        }
      });
      ipcRenderer.send('download', url, filePath);
    }


    /*
    let file = fs.createWriteStream(filePath);
    let source = axios.CancelToken.source();
    axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 30000,
      cancelToken: source.token
    })
      .then(function (response) {
        /*if (response.status !== 200) {
          console.log(`OmdbHelper problem downloading artwork: ${response.status} : ${response.statusText}.`)
          reject();
        }
        // pipe data to file
        response.data.pipe(file);
      })
      .catch(function (error) {
        // delete file
        fs.unlink(filePath, (errfs) => {
          if (errfs) console.log(errfs);
          else {
            console.log("Deleted file");
          }
        });
        reject(error.message);
      })

      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });

      file.on('error', (err) => { // Handle errors
          fs.unlink(filePath, (errfs) => {
            if (errfs) console.log(errfs);
            else {
              console.log("Deleted file");
            }
          });
          reject(err.message);
      });*/
  });
}

module.exports = {search};
