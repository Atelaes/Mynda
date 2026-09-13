// ID scheme versions are permanent protocol identifiers, shared by the
// scanner, migration utility, saved libraries, and Share manifests.
const VIDEO_ID_SCHEME = 2;
const VIDEO_ID_PATTERN = /^[0-9a-f]{64}$/;

function isVideoID(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

function libraryIdentityIssue(data) {
  if (!data || data.videoIdScheme !== VIDEO_ID_SCHEME) {
    const legacy = data && (data.videoIdScheme === undefined || data.videoIdScheme === 1);
    return {
      code: legacy ? 'LIBRARY_ID_MIGRATION_REQUIRED' : 'UNSUPPORTED_VIDEO_ID_SCHEME',
      message: legacy ? 'This library needs the one-time video ID conversion before it can be opened in this version of Mynda.' :
        'This library uses a video ID format that this version of Mynda cannot open.',
      foundScheme: data && data.videoIdScheme,
      expectedScheme: VIDEO_ID_SCHEME
    };
  }
  for (const list of ['media', 'inactive_media']) {
    for (const video of (Array.isArray(data[list]) ? data[list] : [])) {
      if (video === null) continue;
      if (!video || !isVideoID(video.id)) {
        return {code: 'INVALID_VIDEO_ID',
          message: 'This library contains video IDs that do not match its declared format. Complete the video ID conversion before opening it.',
          list, videoID: video && video.id};
      }
    }
  }
  return null;
}

function assertLibraryIdentity(data) {
  const issue = libraryIdentityIssue(data);
  if (!issue) return;
  const error = new Error(issue.message);
  error.code = issue.code;
  error.details = issue;
  throw error;
}

module.exports = {VIDEO_ID_SCHEME, isVideoID, libraryIdentityIssue, assertLibraryIdentity};
