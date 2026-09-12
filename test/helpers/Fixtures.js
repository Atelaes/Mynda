function videoFixture(overrides = {}) {
  return Object.assign({
    id: 'video-1',
    title: 'Alien',
    year: 1979,
    series: '',
    season: '',
    episode: '',
    director: 'Ridley Scott',
    directorsort: 'Scott, Ridley',
    cast: ['Sigourney Weaver'],
    description: 'A commercial space crew encounters an unknown lifeform.',
    genre: 'Horror',
    tags: ['Science Fiction'],
    seen: false,
    new: true,
    position: 0,
    ratings: {imdb: '8.5', rt: 93, mc: 89, user: ''},
    dateadded: 1700000000,
    lastseen: '',
    kind: 'movie',
    filename: '/media/Movies/Alien (1979)/Alien.mkv',
    duplicates: [],
    artwork: '',
    subtitles: [],
    boxoffice: '',
    rated: 'R',
    languages: ['English'],
    country: 'United Kingdom',
    metadata: {
      codec: 'h264',
      duration: 7020,
      width: 1920,
      height: 1080,
      aspect_ratio: '16:9',
      framerate: 24,
      audio_codec: 'aac',
      audio_layout: 'stereo',
      audio_channels: 2
    },
    imdbID: 'tt0078748',
    seriesImdbID: '',
    autotag_tried: true,
    dvd: false,
    watchlater: false
  }, overrides);
}

function libraryFixture(overrides = {}) {
  return Object.assign({
    id: 'library-test',
    settings: {
      watchfolders: [],
      themes: {appearances: [], layouts: []},
      preferences: {
        remove_edited_from_new: false,
        exclude_samples_from_library: true,
        exclude_trailers_from_library: true,
        override_dialogs: {}
      },
      used: {kinds: ['movie', 'show'], genres: [], tags: []}
    },
    playlists: [],
    recently_watched: [],
    media: [],
    object_media: {},
    inactive_media: []
  }, overrides);
}

module.exports = {videoFixture, libraryFixture};
