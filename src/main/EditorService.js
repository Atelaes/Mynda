// Privileged editor operations. Drafts are never committed by this service;
// the renderer's normal revision-aware Save remains the only commit boundary.
const fs = require('fs');
const path = require('path');
const {randomBytes} = require('crypto');
const Evidence = require('../tagging/TaggingEvidence');
const {subtitleExtensions} = require('../scanning/SubtitleMatcher');
const {createArtworkDownloader, artworkURL, MAX_ARTWORK_BYTES} = require('./EditorArtworkDownload');

const copy = value => JSON.parse(JSON.stringify(value));
const scalarFields = ['kind', 'title', 'series', 'year', 'season', 'episode', 'imdbID',
  'seriesImdbID', 'director', 'directorsort', 'description', 'genre', 'country', 'rated',
  'boxoffice', 'artwork', 'position', 'seen', 'watchlater', 'new', 'dateadded', 'lastseen'];
const arrayFields = ['tags', 'cast', 'languages', 'subtitles'];

function boundedText(value, name, maximum = 4096) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function imageExtension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return '.gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return '.bmp';
  return null;
}

function createEditorService({library, catalog, dialog, app, downloadFile = createArtworkDownloader(),
  deriveFilenameResetChanges, isAutoTagRunning = () => false,
  confirmationDialogIsDisabled = () => false, disableConfirmationDialog = () => {},
  now = Date.now, notifyLookup = () => {}, requireFeature = async()=>{}}) {
  const proposals = new Map();
  const grants = new Map();
  const closedOwners = new Set();
  const lookups = new Map();
  async function runLookup(owner, lookupID, videoID, operation) {
    requireOwner(owner);
    if (lookupID === undefined) lookupID = randomBytes(16).toString('hex');
    if (typeof lookupID !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(lookupID)) throw new TypeError('Invalid lookup ID');
    const previous = lookups.get(owner);
    if (previous) previous.controller.abort();
    const current = {lookupID,controller:new AbortController(),waits:new Map()};
    lookups.set(owner,current);
    const notify = () => {
      if (lookups.get(owner) === current && !closedOwners.has(owner)) notifyLookup(owner,
        {lookupID,videoID,capacityWait:current.waits.size ? current.waits.values().next().value : null});
    };
    const control = {workload:'interactive',signal:current.controller.signal,
      onCapacityWait:status => {
        if (status.waiting) current.waits.set(status.waitID,status);
        else current.waits.delete(status.waitID);
        notify();
      }};
    try {
      await requireFeature('tagging');
      if (current.controller.signal.aborted) return {status:'canceled'};
      requireOwner(owner);
      const result = await operation(control);
      return current.controller.signal.aborted ? {status:'canceled'} : result;
    } catch (error) {
      if (current.controller.signal.aborted) return {status:'canceled'};
      throw error;
    } finally {
      current.waits.clear();
      notify();
      if (lookups.get(owner) === current) lookups.delete(owner);
    }
  }
  function cancelSearch(input, owner) {
    const current = lookups.get(owner);
    if (!current || !input || current.lookupID !== input.lookupID) return {canceled:false};
    current.controller.abort();
    return {canceled:true};
  }
  function requireOwner(owner) {
    if (closedOwners.has(owner)) throw new Error('The editor window has closed.');
  }
  function fileIdentity(value) {
    const real = fs.realpathSync(value), stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('Choose a regular file.');
    return JSON.stringify([real, stat.dev, stat.ino, stat.size, stat.mtimeMs]);
  }
  function grant(owner, kind, value) {
    requireOwner(owner);
    // Every artwork entry point returns the same canonical spelling, including
    // newly copied/downloaded files under an aliased user-data directory.
    if (kind === 'artwork') value = fs.realpathSync(value);
    if (!grants.has(owner)) grants.set(owner, {artwork: new Map(), subtitles: new Map(), urls: new Set()});
    if (kind === 'urls') grants.get(owner).urls.add(value);
    else grants.get(owner)[kind].set(value, fileIdentity(value));
    return value;
  }
  function authorizedFile(value, owner, kind) {
    const records = grants.get(owner) && grants.get(owner)[kind];
    if (!records || !records.has(value)) return false;
    try { return records.get(value) === fileIdentity(value); }
    catch (_) { return false; }
  }
  const authorizeArtwork = (value, owner) => authorizedFile(value, owner, 'artwork');
  const authorizeSubtitle = (value, owner) => authorizedFile(value, owner, 'subtitles');
  const knownArtwork = value => [...(library.media || []), ...(library.inactive_media || [])].some(video => video && video.artwork === value);
  const knownSubtitle = value => [...(library.media || []), ...(library.inactive_media || [])].some(video =>
    video && Array.isArray(video.subtitles) && video.subtitles.includes(value));
  const artworkFolder = path.join(app.getPath('userData'), 'Library', 'Artwork');
  const temporaryFolder = path.join(app.getPath('userData'), 'temp');

  function catalogArtwork(owner, row) {
    try { grant(owner, 'urls', artworkURL(row.Poster).href); }
    catch (_) { /* Records without artwork are ordinary catalog results. */ }
  }
  async function approveArtworkURL(value, owner) {
    const url = artworkURL(value).href;
    if (grants.get(owner) && grants.get(owner).urls.has(url)) return true;
    const result = await dialog.showMessageBox({type: 'question', buttons: ['Cancel', 'Download Image'],
      defaultId: 0, cancelId: 0, noLink: true, message: 'Download artwork from this address?', detail: url});
    if (result.response !== 1) return false;
    grant(owner, 'urls', url);
    return true;
  }

  function draftVideo(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new TypeError('Invalid video draft');
    const id = boundedText(draft.id, 'video ID', 256);
    const source = [...(library.media || []), ...(library.inactive_media || [])].find(video => video && video.id === id);
    if (!source) throw new Error('This video is no longer in the library.');
    const video = copy(source);
    const edited = {};
    for (const field of scalarFields) {
      if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
      const value = draft[field];
      if (typeof value === 'string') boundedText(value, field, field === 'description' ? 100000 : 8192);
      else if (value !== null && !['number','boolean'].includes(typeof value)) throw new TypeError(`Invalid ${field}`);
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Invalid ${field}`);
      video[field] = value;
      if (value !== source[field]) edited[field] = value;
    }
    for (const field of arrayFields) {
      if (!Object.prototype.hasOwnProperty.call(draft, field)) continue;
      if (!Array.isArray(draft[field]) || draft[field].length > 2000) throw new TypeError(`Invalid ${field}`);
      video[field] = draft[field].map(value => boundedText(value, field));
    }
    if (draft.ratings !== undefined) {
      if (!draft.ratings || typeof draft.ratings !== 'object' || Array.isArray(draft.ratings)) throw new TypeError('Invalid ratings');
      video.ratings = {...source.ratings};
      for (const field of ['user','imdb','rt','mc']) {
        const value = draft.ratings[field];
        if (value === undefined) continue;
        if (!(value === '' || value === null || typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && value.length < 32 && /^\d+(?:\.\d+)?$/.test(value))) throw new TypeError('Invalid rating');
        video.ratings[field] = value;
      }
    }
    // File paths, technical metadata and saved evidence come from the library.
    // An explicit ID typed in the editor receives user provenance here.
    return Evidence.markUserEdit(video, edited);
  }

  function remember(owner, video, detail) {
    requireOwner(owner);
    for (const [key, value] of proposals) if (now() - value.created > 30 * 60 * 1000) proposals.delete(key);
    while (proposals.size >= 1000) proposals.delete(proposals.keys().next().value);
    const token = randomBytes(24).toString('hex');
    proposals.set(token, {owner, input: Evidence.snapshot(video), created: now(), ...detail});
    return token;
  }

  async function search(draft, owner) {
    return runLookup(owner, draft && draft.lookupID, draft && draft.id,
      control => searchLookup(draft, owner, control));
  }
  async function searchLookup(draft, owner, control) {
    requireOwner(owner);
    const video = draftVideo(draft);
    const result = await catalog.resolve(video, {requestControl:control});
    if (control.signal.aborted) return {status:'canceled'};
    if (result.status === 'candidate') {
      catalogArtwork(owner, result.candidate.record);
      const proposalID = remember(owner, video, {proposal: result});
      // Context contains run caches and promises. Only the display record and
      // identity snapshot cross the bridge; evidence stays with its proposal.
      return {status: 'candidate', proposalID, candidate: {record: copy(result.candidate.record)},
        context: {originalInput: Evidence.snapshot(video)}};
    }
    if (result.status === 'ambiguous') {
      (result.choices || []).forEach(row => catalogArtwork(owner, row));
      return {status: 'ambiguous', choices: (result.choices || []).map(row => ({...copy(row),
        myndaProposalID: remember(owner, video, {choice: copy(row)})}))};
    }
    return {status: result.status, reason: copy(result.reason || {})};
  }

  async function select({draft, choice, lookupID} = {}, owner) {
    return runLookup(owner, lookupID, draft && draft.id,
      control => selectLookup({draft,choice}, owner, control));
  }
  async function selectLookup({draft, choice}, owner, control) {
    requireOwner(owner);
    const video = draftVideo(draft);
    const token = choice && boundedText(choice.myndaProposalID, 'The catalog choice', 128);
    const stored = token && proposals.get(token);
    if (!stored || stored.owner !== owner || now() - stored.created > 30 * 60 * 1000 ||
        JSON.stringify(stored.input) !== JSON.stringify(Evidence.snapshot(video))) {
      throw new Error('The video or search changed. Search again before choosing a result.');
    }
    proposals.delete(token);
    if (stored.proposal) {
      const proposal = stored.proposal;
      // Discovery may correct season/episode numbering. Keep that candidate
      // identity while refreshing unrelated draft fields such as user ratings.
      const identity = new Set(Object.keys(Evidence.snapshot(video)).concat('metadata','dvd'));
      const latest = {...proposal.candidate.video};
      for (const [field, value] of Object.entries(video)) if (!identity.has(field)) latest[field] = value;
      return acceptArtwork(await catalog.applyMatch({...proposal, context:{...proposal.context,requestControl:control}, candidate: {...proposal.candidate, video: latest}},
        {recordSelectionSource: 'user'}), video, owner);
    }
    const row = stored.choice;
    const result = await (row.myndaChoiceType === 'series' ?
      catalog.tag(video, {seriesImdbID: row.imdbID, seriesSelectionSource: 'user',requestControl:control}) :
      catalog.tag({...video, imdbID: row.imdbID}, {imdbIDSource: 'user',requestControl:control}));
    return acceptArtwork(result, video, owner);
  }

  async function artworkBytes(value) {
    boundedText(value, 'artwork path');
    if (!path.isAbsolute(value)) throw new TypeError('Artwork must be an absolute file path.');
    const source = await fs.promises.realpath(value);
    const handle = await fs.promises.open(source, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ARTWORK_BYTES || stat.size < 12) throw new Error('Choose an image file smaller than 20 MB.');
      const bytes = await handle.readFile();
      const extension = imageExtension(bytes);
      if (!extension) throw new Error('Choose a PNG, JPEG, GIF, WebP or BMP image.');
      return {source, bytes, extension};
    } finally { await handle.close(); }
  }

  async function acceptArtwork(result, video, owner) {
    if (result && result.status === 'matched' && result.video && result.video.artwork) {
      try { result.video.artwork = grant(owner, 'artwork', (await artworkBytes(result.video.artwork)).source); }
      catch (_) { result.video.artwork = video.artwork || ''; }
    }
    return result;
  }
  async function inspectArtwork(value, owner) {
    boundedText(value, 'artwork path');
    if (!path.isAbsolute(value)) throw new TypeError('Artwork must be an absolute file path.');
    if (!authorizeArtwork(value, owner) && !knownArtwork(value)) {
      const result = await dialog.showMessageBox({type: 'question', buttons: ['Cancel', 'Use Image'],
        defaultId: 0, cancelId: 0, noLink: true, message: 'Use this image as artwork?', detail: value});
      if (result.response !== 1) return null;
    }
    return grant(owner, 'artwork', (await artworkBytes(value)).source);
  }
  async function prepareArtwork(value, owner) {
    if (value === '') return '';
    if (!authorizeArtwork(value, owner) && !knownArtwork(value)) throw new Error('Choose or confirm this image before saving it.');
    const {source, bytes, extension} = await artworkBytes(value);
    await fs.promises.mkdir(artworkFolder, {recursive: true});
    if (path.dirname(source) === await fs.promises.realpath(artworkFolder)) return grant(owner, 'artwork', source);
    const destination = path.join(artworkFolder, randomBytes(24).toString('hex') + extension);
    await fs.promises.writeFile(destination, bytes, {flag: 'wx'});
    return grant(owner, 'artwork', destination);
  }

  async function downloadArtwork(value, owner) {
    const url = artworkURL(boundedText(value, 'artwork URL', 8192));
    if (!await approveArtworkURL(url.href, owner)) return {success: false, message: 'Artwork download canceled'};
    await fs.promises.mkdir(temporaryFolder, {recursive: true});
    const destination = path.join(temporaryFolder, randomBytes(24).toString('hex') + '.image');
    try {
      const result = await downloadFile(url.href, destination, {approveRedirect: next => approveArtworkURL(next, owner)});
      if (!result || !result.success) throw new Error(result && result.message || 'Download failed');
      // Never return unchecked remote HTML/SVG as a local privileged resource.
      const {extension} = await artworkBytes(destination);
      requireOwner(owner);
      const imagePath = destination + extension;
      await fs.promises.rename(destination, imagePath);
      return {success: true, message: grant(owner, 'artwork', imagePath)};
    } catch (error) {
      await fs.promises.unlink(destination).catch(() => {});
      return {success: false, message: error && error.message || String(error), status: error && error.status};
    }
  }

  async function chooseArtwork(owner) {
    const result = await dialog.showOpenDialog({filters: [{name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','bmp']}], properties: ['openFile']});
    if (result.canceled || !result.filePaths[0]) return null;
    return grant(owner, 'artwork', (await artworkBytes(result.filePaths[0])).source);
  }
  async function validateSubtitles(values, owner) {
    if (!Array.isArray(values) || values.length > 2000) throw new TypeError('Invalid subtitle list');
    const accepted = [], rejected = [];
    for (const value of values) boundedText(value, 'subtitle path');
    const needConsent = [...new Set(values)].filter(value => !authorizeSubtitle(value, owner) && !knownSubtitle(value));
    let allowNew = false;
    if (needConsent.length) {
      const result = await dialog.showMessageBox({type: 'question', buttons: ['Cancel', 'Add Subtitles'],
        defaultId: 0, cancelId: 0, noLink: true, message: 'Add these subtitle files?', detail: needConsent.join('\n')});
      allowNew = result.response === 1;
    }
    for (const value of new Set(values)) {
      try {
        if (needConsent.includes(value) && !allowNew) throw new Error('Subtitle file was not confirmed');
        boundedText(value, 'subtitle path');
        if (!path.isAbsolute(value) || !subtitleExtensions.includes(path.extname(value).slice(1).toLowerCase()) ||
          !(await fs.promises.stat(value)).isFile()) throw new Error('Invalid subtitle file');
        accepted.push(grant(owner, 'subtitles', value));
      } catch (_) { rejected.push(value); }
    }
    return {accepted, rejected};
  }
  async function chooseSubtitles(owner) {
    const result = await dialog.showOpenDialog({filters: [{name: 'Subtitles', extensions: subtitleExtensions}], properties: ['openFile','multiSelections']});
    if (result.canceled) return [];
    // Selection in the native file picker is the authorization; subsequent
    // validation and Save must not display another confirmation.
    result.filePaths.forEach(value => grant(owner, 'subtitles', value));
    return (await validateSubtitles(result.filePaths, owner)).accepted;
  }

  async function confirm(options = {}) {
    const messages = {
      'select-result': () => `Are you sure you want to choose ${boundedText(options.title || '', 'title')} (${boundedText(String(options.year || ''), 'year', 100)})? This will overwrite most of the existing information for this video.`,
      'revert': () => 'Are you sure you want to revert to the saved values? You will lose any unsaved changes.',
      'remove-list-item': () => `Are you sure you want to remove '${boundedText(options.item || '', 'item')}'? ${boundedText(options.description || '', 'description')}`
    };
    if (!Object.prototype.hasOwnProperty.call(messages, options.kind)) throw new TypeError('Invalid editor confirmation');
    return dialog.showMessageBox({type: 'question', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
      noLink: true, message: messages[options.kind](), ...(options.checkbox ? {checkboxLabel: "Don't show this message again"} : {})});
  }

  async function resetFromFilename(drafts) {
    if (!Array.isArray(drafts) || !drafts.length || drafts.length > 10000) throw new TypeError('Invalid reset selection');
    if (isAutoTagRunning()) return {confirmed: false, error: 'Auto-Tag is still running or finishing its saves. Cancel it or wait for it to finish, then try Reset from Filename again.'};
    const patches = drafts.map(draft => deriveFilenameResetChanges(draftVideo(draft)));
    const preference = 'MynEditor-confirm-reset-from-filename';
    let confirmed = confirmationDialogIsDisabled(preference);
    if (!confirmed) {
      const missing = patches.filter(patch => !patch.watchfolderFound).length;
      const result = await dialog.showMessageBox({type: 'warning', buttons: ['Cancel','Reset from Filename'],
        defaultId: 0, cancelId: 0, noLink: true, checkboxLabel: "Don't show this message again",
        message: patches.length === 1 ? 'Reset this video from its filename?' : `Reset ${patches.length} videos from their filenames?`,
        detail: 'Mynda will re-detect title, series, season, and episode from each filename and its folders. ' +
          "It will restore the watchfolder's default kind, clear the IMDb ID, artwork reference, and other catalog fields, mark the video as New, and allow Auto-Tag to try it again.\n\n" +
          'Tags, subtitles, watched status, playback position, technical metadata, and your rating will be kept. Nothing is written to the library until you click Save in the editor.' +
          (missing ? `\n\nFor ${missing} videos without a known watchfolder, Mynda will use the filename alone and keep the current kind.` : '')});
      confirmed = result.response === 1;
      if (confirmed && result.checkboxChecked) await disableConfirmationDialog(preference);
    }
    return {confirmed, patches: confirmed ? patches.map(({id, changes}) => ({id, changes})) : []};
  }

  function dispose(owner) {
    closedOwners.add(owner);
    if (lookups.has(owner)) lookups.get(owner).controller.abort();
    lookups.delete(owner);
    for (const [key, value] of proposals) if (value.owner === owner) proposals.delete(key);
    grants.delete(owner);
  }
  return {search, select, cancelSearch, inspectArtwork, prepareArtwork, downloadArtwork, chooseArtwork,
    chooseSubtitles, validateSubtitles, confirm, resetFromFilename, authorizeArtwork, authorizeSubtitle, dispose};
}

module.exports = {createEditorService, imageExtension};
