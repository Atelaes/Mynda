// Pure and near-pure helpers shared by renderer component groups.
const _ = require('lodash');
const URL = require('url');
const {v4: uuidv4} = require('uuid');
const {frontendLog} = require('./RendererRuntime.js');

// React may give the editor freshly cloned props even though the user is
// still editing the exact same video selection. Compare stable video IDs
// rather than object identity so those harmless refreshes cannot discard
// filename-reset patches or other editor state that has not been saved yet.
function editorSelectionKey(video, batch) {
  if (!video) return '';
  if (video.id !== 'batch') return `single:${video.id || ''}`;

  const ids = (Array.isArray(batch) ? batch : [])
    .map(item => item && item.id)
    .filter(Boolean)
    .sort();
  return `batch:${JSON.stringify(ids)}`;
}

// A batch checkbox needs three display states: checked when every selected
// video is New, unchecked when none are New, and indeterminate when the
// selection is mixed. Null is used only by the editable batch summary; the
// individual videos retain ordinary boolean values.
function batchNewState(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return false;

  const numberNew = videos.filter(video => video && video.new === true).length;
  if (numberNew === videos.length) return true;
  if (numberNew === 0) return false;
  return null;
}

// Mynda permits manually interlaced episode positions such as 3.5 while
// keeping the field predictable for display, sorting, and batch editing.
// Require a nonnegative ordinary decimal with at most one digit after the
// point; scientific notation, signs, and higher precision are deliberately
// excluded. The returned number also gives validateVideo() one canonical form
// without ever truncating a fractional episode.
function parseEditableEpisodeNumber(value) {
  let text = String(value === null || typeof value === 'undefined' ? '' : value).trim();
  if (!/^\d+(?:\.\d)?$/.test(text)) return null;

  let episode = Number(text);
  return Number.isFinite(episode) && episode >= 0 ? episode : null;
}

const EDITOR_RATING_SOURCES = ['imdb', 'rt', 'mc', 'user'];

// Ratings arrive from several generations of library data as numbers,
// numeric strings, empty strings, or missing properties. Treat values that
// render identically in the editor as equal so returning an input to what the
// user originally saw also returns the batch field to its untouched state.
function normalizeEditorRatingValue(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

function editorRatingValuesEqual(first, second) {
  return normalizeEditorRatingValue(first) === normalizeEditorRatingValue(second);
}

function editorRatingsEqual(first, second) {
  const firstRatings = first && typeof first === 'object' ? first : {};
  const secondRatings = second && typeof second === 'object' ? second : {};
  const sources = new Set([
    ...EDITOR_RATING_SOURCES,
    ...Object.keys(firstRatings),
    ...Object.keys(secondRatings)
  ]);

  return Array.from(sources).every(source =>
    editorRatingValuesEqual(firstRatings[source], secondRatings[source])
  );
}

// Build a complete, detached ratings summary for a batch. In particular, a
// source missing from the first selected video must not hide a value present
// on a later video, and finding a mixed value must never mutate either source.
function batchRatingsState(videos) {
  const safeVideos = Array.isArray(videos) ? videos.filter(Boolean) : [];
  const sources = new Set(EDITOR_RATING_SOURCES);
  safeVideos.forEach(video => {
    if (video.ratings && typeof video.ratings === 'object') {
      Object.keys(video.ratings).forEach(source => sources.add(source));
    }
  });

  const ratings = {};
  const firstRatings = safeVideos[0] && safeVideos[0].ratings &&
    typeof safeVideos[0].ratings === 'object' ? safeVideos[0].ratings : {};
  sources.forEach(source => {
    const firstValue = firstRatings[source];
    const common = safeVideos.length > 0 && safeVideos.every(video => {
      const videoRatings = video.ratings && typeof video.ratings === 'object' ? video.ratings : {};
      return editorRatingValuesEqual(videoRatings[source], firstValue);
    });
    ratings[source] = common && firstValue !== undefined && firstValue !== null ?
      _.cloneDeep(firstValue) : '';
  });
  return ratings;
}

// The empty value in a batch field has two distinct meanings. If every video
// originally shared a non-empty value, clearing it is an intentional edit. If
// the videos originally differed, the batch summary was already empty, and
// returning to empty means "leave each video's value alone." Compare against
// the untouched batch summary instead of treating every empty value alike.
function updateEditorChangedField(changedFields, video, batchBaseline, field, value) {
  const hasBatchBaseline = video && video.id === 'batch' && batchBaseline &&
    Object.prototype.hasOwnProperty.call(batchBaseline, field);
  const isChanged = hasBatchBaseline ?
    (field === 'ratings' ?
      !editorRatingsEqual(value, batchBaseline[field]) :
      !_.isEqual(value, batchBaseline[field])) : value !== '';

  if (isChanged) {
    changedFields.add(field);
  } else {
    changedFields.delete(field);
  }
  return isChanged;
}


// let savedPing = {};

// helper function to test whether a video object is a valid video
// all it does right now is check for top-level properties
// eventually it should do more than that
function validateVideo(video) {
  if (typeof video === undefined || video === null) {
    return false;
  }
  // let repaired = _.cloneDeep(video);
  let repaired = video; // don't clone, because we want to alter the video in place
  let oldVidCopy = _.cloneDeep(video); // but do clone a copy for comparison at the end

  const properties = {
    'id':'string',
    'title':'string',
    'year':'integer',
    'series':'string',
    'season':'integer',
    'episode':'episodeNumber',
    'director':'string',
    'directorsort':'string',
    'cast':'array',
    'description':'string',
    'genre':'string',
    'tags':'array',
    'seen':'boolean',
    'position':'integer',
    'ratings':'object',
    'dateadded':'integer',
    'lastseen':'integer',
    'kind':'string',
    'filename':'string',
    'artwork':'string',
    'subtitles':'array',
    'boxoffice':'number',
    'rated':'string',
    'languages':'array',
    'country':'string',
    'metadata':'object',
    'imdbID':'string',
    'seriesImdbID':'string',
    'autotag_tried':'boolean',
    'dvd':'boolean',
    'watchlater':'boolean'
  };

  let vidProps = Object.keys(video);
  let propKeys = Object.keys(properties);
  for (const property of propKeys) {
    // if (vidProps.includes(property)) {
      // repair any malformed properties
      switch(properties[property]) {
        // ratings and metadata
        case 'object' :
          if (typeof video[property] === 'undefined' || typeof video[property] !== 'object' || typeof video[property] === null) {
            if (property === 'metadata') {
              repaired[property] = {
                "codec" : "",
                "duration" : 0,
                "width" : 0,
                "height" : 0,
                "aspect_ratio" : "",
                "framerate" : 0,
                "audio_codec" : "",
                "audio_layout" : "",
                "audio_channels" : 0
              }
            } else {
              repaired[property] = {};
            }
          }
          break;
        // tags, cast, languages
        case 'array' :
          if (!Array.isArray(video[property])) {
            repaired[property] = [];
          }
          break;
        // episode permits a manually assigned interlaced position such as 3.5
        case 'episodeNumber' :
          repaired[property] = parseEditableEpisodeNumber(video[property]);
          if (repaired[property] === null) {
            repaired[property] = '';
          }
          break;
        // year, season, position, dateadded, lastseen
        // season also permits the special "extras" category
        case 'integer' :
          if (property === 'season' && String(video[property]).toLowerCase() === 'extras') {
            repaired[property] = 'extras';
            break;
          }
          repaired[property] = parseInt(video[property]);
          if (!Number.isInteger(repaired[property])) {
            repaired[property] = ''; // going with empty string instead of some integer like 0 or -1, for a variety of reasons
          }
          break;
        // boxoffice
        case 'number' :
          if (isNaN(video[property])) {
            // repaired[property] = 0;
            repaired[property] = ''; // we want to go with an empty string here, because the editor is set up to treat the empty string as, effectively, an unset value
          }
          break;
        // seen
        case 'boolean' :
          if (typeof video[property] !== 'boolean') {
            repaired[property] = false;
          }
          break;
        // most things
        case 'string' :
          if (typeof video[property] !== 'string') {
            repaired[property] = '';
          }
      }
    // } else {
    //   // the property doesn't exist, so create it
    //   repaired[property] = '';
    // }
  }

  // Video fields are intentionally universal rather than kind-dependent.
  // Keep the parent-series field present everywhere, but never retain a value
  // on a movie or custom kind where it would have no meaning.
  if (repaired.kind !== 'show') {
    repaired.seriesImdbID = '';
  }

  // if no id, create one
  if (!video.id || video.id === '') {
    video.id = uuidv4();
    frontendLog.warn('Renderer repaired a video that did not have an ID', {
      filename: video.filename,
      generatedVideoID: video.id
    });
  }

  // if the ratings object doesn't have all the sources, fill it with empty values;
  // most things will work fine if we don't do this, but the bit of logic
  // that tests whether or not a video has changed in the video editor since last save
  // breaks without the keys present in this object (MynEditRatings doesn't
  // add them on load, but DOES add them on revert-to-saved, making MynEditorEdit think
  // that the video has changed even right after it's reverted)
  const keys = Object.keys(video.ratings);
  const sources = ['imdb','rt','mc','user'];
  sources.map(source => {
    if (!keys.includes(source)) video.ratings[source] = '';
  });

  if (!_.isEqual(oldVidCopy,repaired)) {
    // console.log('video had to be repaired: ' + video.title);
    // return repaired;
    return false;
  } else {
    return true;
  }
}

// helper function to determine if a string is a valid URL
function isValidURL(s) {
  try {
    let url = new URL.URL(s);
    return url.host !== '';
  } catch (error) {
    return false;
  }
}

// finds first element with targetClass, either the element itself,
// or the nearest of its ancestors; this prevents bubbling problems
// by ensuring that we know which element we're operating on,
// instead of relying on event.target, which could be a child element
function findNearestOfClass(element, targetClass) {
  while (!element.classList.contains(targetClass) && (element = element.parentElement));
  return element;
}

// https://stackoverflow.com/a/40610459
function getObjectDiff(obj1, obj2) {
  const diff = Object.keys(obj1).reduce((result, key) => {
    if (!obj2.hasOwnProperty(key)) {
      result.push(key);
    } else if (_.isEqual(obj1[key], obj2[key])) {
      const resultKeyIndex = result.indexOf(key);
      result.splice(resultKeyIndex, 1);
    }
    return result;
  }, Object.keys(obj2));

  return diff;
}

function getArrayDiff(arr1,arr2) {
  arr1 = _.cloneDeep(arr1);
  arr2 = _.cloneDeep(arr2);
  let diff = [];

  arr1.map((el,index) => {
    let found = false;
    for (let i=0; i<arr2.length; i++) {
      if (_.isEqual(el,arr2[i])) {
        arr2.splice(i, 1);
        found = true;
        break;
      }
    }
    if (!found) {
      diff.push(el);
    }
  });

  diff = [...diff,...arr2];
  return diff;
}

function isEqualIgnoreFuncs(obj1,obj2) {
  // console.log('-----isEqualIgnoreFuncs----');

  // console.log('Originals...');
  // console.log(obj1);
  // console.log(obj2);
  // console.log(`isEqual? ${_.isEqual(obj1,obj2)}`);

  const shallowCloneNoFunc = (obj) => {
    let copy = {}
    Object.keys(obj).map((key) => {
      if (!_.isFunction(obj[key]))
        copy[key] = obj[key];
    });
    return copy;
  };

  const deepCloneNoFunc = (obj) => {
    let copy = {}
    Object.keys(obj).map((key) => {
      if (!_.isFunction(obj[key]))
        copy[key] = _.cloneDeep(obj[key]);
    });
    return copy;
  };


  let new1 = _.cloneDeepWith(obj1,deepCloneNoFunc);
  let new2 = _.cloneDeepWith(obj2,deepCloneNoFunc);

  // console.log('NoFunc Clones...');
  // console.log(new1);
  // console.log(new2);
  // console.log(`isEqual? ${_.isEqual(new1,new2)}`);

  return _.isEqual(new1,new2);
}

module.exports = {
  editorSelectionKey,
  batchNewState,
  parseEditableEpisodeNumber,
  normalizeEditorRatingValue,
  editorRatingValuesEqual,
  editorRatingsEqual,
  batchRatingsState,
  updateEditorChangedField,
  validateVideo,
  isValidURL,
  findNearestOfClass,
  getObjectDiff,
  getArrayDiff,
  isEqualIgnoreFuncs
};
