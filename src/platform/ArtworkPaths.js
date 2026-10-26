'use strict';

const fs = require('fs');
const path = require('path');
const {isRelativeArtwork} = require('./ArtworkReference');

function pathAPI(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? path.win32 : path;
}

// The managed artwork location is defined only here. Library files store paths
// relative to this directory, so moving it does not rewrite those references.
function artworkDirectory(userData) {
  return pathAPI(userData).join(userData, 'Library', 'Artwork');
}

function createArtworkPaths({userData, legacyDirectories = []}) {
  if (typeof userData !== 'string' || !pathAPI(userData).isAbsolute(userData)) {
    throw new TypeError('The artwork profile directory must be absolute.');
  }
  const api = pathAPI(userData);
  const directory = artworkDirectory(userData);
  const roots = [directory, ...legacyDirectories];
  if (/^mynda$/i.test(api.basename(userData))) {
    roots.push(artworkDirectory(api.join(api.dirname(userData), 'mynda')),
      artworkDirectory(api.join(api.dirname(userData), 'Mynda')));
  }

  // Resolve existing ancestors too: profiles may use /var -> /private/var or a
  // symlink even while an image (or the artwork directory) is not created yet.
  function canonical(value) {
    if (api !== path && process.platform !== 'win32') return value;
    let current = value;
    const missing = [];
    while (true) {
      try { return api.join(fs.realpathSync(current), ...missing); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        const parent = api.dirname(current);
        if (parent === current) return value;
        missing.unshift(api.basename(current));
        current = parent;
      }
    }
  }
  function relativeTo(root, value) {
    const relative = api.relative(root, value).split(api.sep).join('/');
    return isRelativeArtwork(relative) ? relative : null;
  }
  function reference(value) {
    if (typeof value !== 'string' || !api.isAbsolute(value) || value.includes('\0')) return value;
    const absolute = api.resolve(value);
    let real;
    try { real = canonical(absolute); }
    catch (_) { return value; }
    for (const root of roots) {
      if (typeof root !== 'string' || !api.isAbsolute(root)) continue;
      let realRoot;
      try { realRoot = canonical(root); }
      catch (_) { continue; }
      const canonicalRelative = relativeTo(realRoot, real);
      if (!canonicalRelative) continue;
      // A file may use either the original profile alias or its real path.
      const lexicalRelative = relativeTo(root, absolute);
      if (lexicalRelative) return lexicalRelative;
      if (relativeTo(realRoot, absolute)) return canonicalRelative;
    }
    return value;
  }
  function resolve(value) {
    if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid artwork path.');
    // Explicit absolute files are still valid editor inputs. Permission to use
    // them comes from the picker/editor grant, never this path conversion.
    if (api.isAbsolute(value)) return value;
    if (!isRelativeArtwork(value)) throw new TypeError('Invalid relative artwork path.');
    const absolute = api.join(directory, ...value.split('/'));
    if (!relativeTo(canonical(directory), canonical(absolute))) {
      throw new TypeError('Artwork path escapes the artwork directory.');
    }
    return absolute;
  }
  return {directory, reference, resolve};
}

module.exports = {artworkDirectory, createArtworkPaths};
