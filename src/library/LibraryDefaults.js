'use strict';
const {v4:uuidv4} = require('uuid');
const VideoIdentity = require('./VideoIdentity');

const defaultLibrary = {
  "id": uuidv4(),
  "videoIdScheme": VideoIdentity.VIDEO_ID_SCHEME,
  "settings": {
    "watchfolders": [],
    "themes": {
      "appearances": [
        {
          "name": "Dark Theme",
          "path": "styles/themes/appearances/dark-theme.css",
          "dependencies": {
            "fonts": [],
            "images": []
          }
        }
      ],
      "layouts": [
        {
          "name": "Default Layout Theme",
          "path": "styles/themes/layouts/default-layout-theme.css",
          "dependencies": {}
        }
      ]
    },
    "preferences": {
      "defaultcolumns": {
        "used": [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused": [
          "kind",
          "lastseen",
          "watchlater",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration",
          "resolution"
        ]
      },
      "defaultdefaultcolumns": {
        "used": [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused": [
          "kind",
          "lastseen",
          "watchlater",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration",
          "resolution"
        ]
      },
      "hide_description": "show",
      "override_dialogs": {
        "MynEditorSearch-confirm-select": false,
        "MynEditor-confirm-exit": false,
        "MynEditorEdit-confirm-revert": false,
        "MynLibTable-confirm-inlineEdit": false,
        "MynAutoTag-confirm-cancel": false,
        "MynEditor-confirm-reset-from-filename": false,
        "MynSettingsFolders-confirm-remove": false,
        "MynSettingsPlaylists-confirm-delete-playlist": false,
        "MynSettingsPrefs-confirm-remove-kind": false
      },
      "include_user_rating_in_avg": false,
      "include_new_vids_in_playlists": true,
      "remove_edited_from_new": false,
      "remove_autotagged_from_new": true,
      "exclude_samples_from_library": true,
      "exclude_trailers_from_library": true
    },
    "used": {
      "kinds": [
        "movie",
        "show"
      ],
      "genres": [],
      "tags": []
    }
  },
  "playlists": [
    {
      "id": "new",
      "name": "New",
      "filter_function": "video.new === true",
      "view": "flat",
      "tab": true,
      "flatDefaultSort": "dateadded",
      "columns": [
        "title",
        "dateadded",
        "seen",
        "ratings_user"
      ]
    },
    {
      "id": "1",
      "name": "Movies",
      "filter_function": "video.kind === 'movie'",
      "view": "flat",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "watchlater",
        "ratings_user",
        "dateadded"
      ]
    },
    {
      "id": "2",
      "name": "Shows",
      "filter_function": "video.kind === 'show'",
      "view": "series",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "watchlater",
        "ratings_user",
        "dateadded"
      ]
    },
    {
      "id": "3",
      "name": "♥",
      "filter_function": "video.watchlater === true",
      "view": "flat",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "ratings_user",
        "dateadded"
      ]
    }
  ],
  "recently_watched": [],
  "media": [],
  "object_media": {},
  "inactive_media": []
};

module.exports = defaultLibrary;
