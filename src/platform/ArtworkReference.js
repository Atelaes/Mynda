'use strict';

// Managed artwork references are plain, portable paths relative to the artwork
// directory. This grammar is shared with the renderer without importing Node.
// Percent signs, spaces, # and ? are literal filename characters, not URL data.
function isRelativeArtwork(value) {
  return typeof value === 'string' && value.length > 0 &&
    !/[\\\0:]/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

module.exports = {isRelativeArtwork};
