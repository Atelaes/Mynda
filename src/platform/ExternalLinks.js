// Approved destinations for links offered by Mynda's UI. Add future provider
// links here deliberately; never pass an arbitrary catalog URL to the OS.
const OPEN_EXTERNAL_CHANNEL = 'external:open';

function imdbTitleURL(id) {
  return typeof id === 'string' && id.length <= 32 && /^tt[0-9]+$/.test(id) ?
    `https://www.imdb.com/title/${id}/` : null;
}

function approvedExternalURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['imdb.com', 'www.imdb.com'].includes(url.hostname) ||
        url.username || url.password || url.port || url.search || url.hash) return null;
    const match = /^\/title\/(tt[0-9]+)\/?$/.exec(url.pathname);
    // Reconstruct the destination instead of handing the original text to a
    // different URL parser in the operating system or browser.
    return match ? imdbTitleURL(match[1]) : null;
  } catch (_) { return null; }
}

module.exports = {OPEN_EXTERNAL_CHANNEL, imdbTitleURL, approvedExternalURL};
