'use strict';

// The backend canonicalizes duplicate paths when loading/scanning the library.
// Browser views only select those display strings; interpreting filesystem
// paths (including Windows case/relative-path rules) belongs to the backend.
function displayDuplicatePaths(paths, primaryPath = '') {
  return [...new Set((Array.isArray(paths) ? paths : []).filter(value =>
    typeof value === 'string' && value.trim() && value !== primaryPath
  ))];
}

module.exports = {displayDuplicatePaths};
