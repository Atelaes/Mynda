const fs = require('fs');
const {Transform, pipeline} = require('stream');
const {promisify} = require('util');
const axios = require('axios');
const pipe = promisify(pipeline);
const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;

function artworkURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Invalid artwork URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Unsupported artwork URL');
  return url;
}

// Redirects are handled explicitly so an approved public image cannot silently
// redirect to a different server (including a user's local services).
function createArtworkDownloader({request = (url, options) => axios.get(url, options)} = {}) {
  return async function download(url, destination, {approveRedirect = async () => false} = {}) {
    let current = artworkURL(url);
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await request(current.href, {responseType: 'stream', maxRedirects: 0,
        timeout: 30000, validateStatus: () => true});
      if ([301,302,303,307,308].includes(response.status)) {
        response.data.destroy();
        if (redirects >= 5) throw new Error('Too many artwork redirects');
        const location = response.headers.location;
        if (typeof location !== 'string') throw new Error('Artwork redirect had no destination');
        const next = artworkURL(new URL(location, current.href).href);
        if (next.origin !== current.origin && !await approveRedirect(next.href)) throw new Error('Artwork redirect was not confirmed');
        current = next;
        continue;
      }
      if (response.status !== 200) {
        response.data.destroy();
        const error = new Error(`Artwork download failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      break;
    }
    if (Number(response.headers['content-length']) > MAX_ARTWORK_BYTES) {
      response.data.destroy();
      throw new Error('Choose an image smaller than 20 MB.');
    }
    let bytes = 0;
    const limit = new Transform({transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_ARTWORK_BYTES ? new Error('Choose an image smaller than 20 MB.') : null, chunk);
    }});
    let created = false;
    const output = fs.createWriteStream(destination, {flags: 'wx'});
    output.once('open', () => { created = true; });
    const timer = setTimeout(() => response.data.destroy(new Error('Artwork download timed out')), 30000);
    try {
      await pipe(response.data, limit, output);
      return {success: true, message: destination};
    } catch (error) {
      if (created) await fs.promises.unlink(destination).catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  };
}

module.exports = {createArtworkDownloader, artworkURL, MAX_ARTWORK_BYTES};
