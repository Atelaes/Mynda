const fs = require('fs');
const path = require('path');

const SHARE_FORMAT = 'mynda-share';
const SHARE_VERSION = 1;
const MANIFEST_FILENAME = 'Mynda Share.json';
const FILES_DIRECTORY = 'Mynda Share Files';
const IMPORT_STAGING_DIRECTORY = '.mynda-share-staging';

class ShareManifestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ShareManifestError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(code, message, details) {
  throw new ShareManifestError(code, message, details);
}

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function normalizeKind(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifestPath(directory) {
  assert(typeof directory === 'string' && directory.trim() !== '',
    'INVALID_SHARE_DIRECTORY', 'Choose a Share directory first.');
  return path.join(path.resolve(directory), MANIFEST_FILENAME);
}

// Paths stored in a Share manifest always use forward slashes. They are
// intentionally relative so a package made on one operating system cannot
// name an arbitrary absolute destination on another one.
function validatePortableRelativePath(value, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  assert(typeof value === 'string' && value.indexOf('\0') === -1,
    'INVALID_SHARE_PATH', 'The Share package contains an invalid path.', {path: value});

  let portable = value.replace(/\\/g, '/');
  assert(!/^[a-zA-Z]:/.test(portable) && !portable.startsWith('/'),
    'UNSAFE_SHARE_PATH', 'The Share package contains an absolute path.', {path: value});

  portable = path.posix.normalize(portable);
  if (portable === '.') portable = '';
  assert((allowEmpty && portable === '') || portable !== '',
    'INVALID_SHARE_PATH', 'The Share package contains an empty path.', {path: value});
  assert(portable !== '..' && !portable.startsWith('../'),
    'UNSAFE_SHARE_PATH', 'The Share package contains a path outside its directory.', {path: value});

  return portable;
}

function toPortableRelativePath(value, options = {}) {
  return validatePortableRelativePath(String(value || '').replace(/\\/g, '/'), options);
}

function safeJoin(root, portableRelativePath) {
  const relativePath = validatePortableRelativePath(portableRelativePath);
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const containment = path.relative(resolvedRoot, destination);
  assert(containment !== '..' && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment),
    'UNSAFE_SHARE_PATH', 'The Share package contains a path outside its directory.', {
      root: resolvedRoot,
      path: portableRelativePath
    });
  return destination;
}

function validateRequestedKinds(requestedKinds) {
  assert(Array.isArray(requestedKinds) && requestedKinds.length > 0,
    'INVALID_SHARE_REQUEST', 'The Share request does not contain any requested media kinds.');

  const ids = new Set();
  const labels = new Set();
  requestedKinds.forEach((kind, index) => {
    assert(isPlainObject(kind), 'INVALID_SHARE_REQUEST',
      'The Share request contains an invalid media kind.', {index: index});
    assert(typeof kind.id === 'string' && kind.id.trim() !== '',
      'INVALID_SHARE_REQUEST', 'A requested media kind is missing its identifier.', {index: index});
    const label = normalizeKind(kind.label);
    assert(label !== '', 'INVALID_SHARE_REQUEST',
      'A requested media kind is missing its name.', {index: index});
    assert(!ids.has(kind.id), 'INVALID_SHARE_REQUEST',
      'The Share request contains a duplicate media-kind identifier.', {id: kind.id});
    assert(!labels.has(label), 'INVALID_SHARE_REQUEST',
      'The Share request contains a duplicate media kind.', {kind: label});
    ids.add(kind.id);
    labels.add(label);
    kind.label = label;
  });
  return ids;
}

function validateInventory(inventory) {
  assert(Array.isArray(inventory), 'INVALID_SHARE_REQUEST',
    'The Share request has an invalid media inventory.');
  const ids = new Set();
  inventory.forEach((entry, index) => {
    assert(isPlainObject(entry) && typeof entry.id === 'string' && entry.id.trim() !== '',
      'INVALID_SHARE_REQUEST', 'The Share inventory contains an invalid video.', {index: index});
    assert(!ids.has(entry.id), 'INVALID_SHARE_REQUEST',
      'The Share inventory contains the same video more than once.', {id: entry.id});
    assert(entry.mediaType === 'file' || entry.mediaType === 'dvd',
      'INVALID_SHARE_REQUEST', 'The Share inventory contains an invalid media type.', {
        id: entry.id,
        mediaType: entry.mediaType
      });
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0,
      'INVALID_SHARE_REQUEST', 'The Share inventory contains an invalid media size.', {
        id: entry.id,
        size: entry.size
      });
    ids.add(entry.id);
  });
}

function validateMappings(mappings, requestedKindIDs) {
  assert(Array.isArray(mappings), 'INVALID_SHARE_FULFILLMENT',
    'The Share fulfillment has invalid media-kind mappings.');
  const mappedRequestedKinds = new Set();
  const mappedSourceKinds = new Set();
  mappings.forEach((mapping, index) => {
    assert(isPlainObject(mapping) && requestedKindIDs.has(mapping.requestedKindId),
      'INVALID_SHARE_FULFILLMENT', 'A Share kind mapping refers to an unknown requested kind.', {
        index: index,
        requestedKindId: mapping && mapping.requestedKindId
      });
    assert(!mappedRequestedKinds.has(mapping.requestedKindId),
      'INVALID_SHARE_FULFILLMENT', 'A requested kind is mapped more than once.', {
        requestedKindId: mapping.requestedKindId
      });
    assert(Array.isArray(mapping.sourceKinds), 'INVALID_SHARE_FULFILLMENT',
      'A Share kind mapping has an invalid source-kind list.', {index: index});
    mapping.sourceKinds = Array.from(new Set(mapping.sourceKinds.map(normalizeKind).filter(Boolean)));
    mapping.sourceKinds.forEach(sourceKind => {
      assert(!mappedSourceKinds.has(sourceKind), 'INVALID_SHARE_FULFILLMENT',
        'A source kind is mapped to more than one requested kind.', {sourceKind: sourceKind});
      mappedSourceKinds.add(sourceKind);
    });
    mappedRequestedKinds.add(mapping.requestedKindId);
  });
  assert(mappedRequestedKinds.size === requestedKindIDs.size,
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment is missing a requested-kind mapping.');
}

function validateManifestFile(file, itemIndex, fileIndex) {
  assert(isPlainObject(file), 'INVALID_SHARE_FULFILLMENT',
    'The Share fulfillment contains an invalid file.', {itemIndex: itemIndex, fileIndex: fileIndex});
  assert(['video', 'dvd-content', 'subtitle'].includes(file.role),
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment contains an unknown file role.', {
      itemIndex: itemIndex,
      fileIndex: fileIndex,
      role: file.role
    });
  file.packagePath = validatePortableRelativePath(file.packagePath);
  file.destinationRelativePath = validatePortableRelativePath(file.destinationRelativePath);
  assert(Number.isSafeInteger(file.size) && file.size >= 0,
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment contains an invalid file size.', {
      itemIndex: itemIndex,
      fileIndex: fileIndex,
      size: file.size
    });
  assert(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256),
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment contains an invalid file checksum.', {
      itemIndex: itemIndex,
      fileIndex: fileIndex
    });
  file.sha256 = file.sha256.toLowerCase();
}

function validateFulfillment(fulfillment, requestedKindIDs) {
  if (fulfillment === null || typeof fulfillment === 'undefined') return;
  assert(isPlainObject(fulfillment), 'INVALID_SHARE_FULFILLMENT',
    'The Share fulfillment section is invalid.');
  assert(['in-progress', 'complete', 'partial', 'canceled'].includes(fulfillment.status),
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment has an invalid status.', {
      status: fulfillment.status
    });
  assert(typeof fulfillment.fulfillingLibraryId === 'string' && fulfillment.fulfillingLibraryId !== '',
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment is missing its source-library identifier.');
  assert(typeof fulfillment.includeDvds === 'boolean', 'INVALID_SHARE_FULFILLMENT',
    'The Share fulfillment has an invalid DVD preference.');
  assert(typeof fulfillment.createdAt === 'string' && !Number.isNaN(Date.parse(fulfillment.createdAt)),
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment has an invalid creation date.');
  assert(typeof fulfillment.updatedAt === 'string' && !Number.isNaN(Date.parse(fulfillment.updatedAt)),
    'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment has an invalid update date.');
  validateMappings(fulfillment.kindMappings || [], requestedKindIDs);
  assert(Array.isArray(fulfillment.items), 'INVALID_SHARE_FULFILLMENT',
    'The Share fulfillment has an invalid item list.');

  const videoIDs = new Set();
  const packageDirectories = new Set();
  fulfillment.items.forEach((item, itemIndex) => {
    assert(isPlainObject(item) && typeof item.videoId === 'string' && item.videoId !== '',
      'INVALID_SHARE_FULFILLMENT', 'The Share fulfillment contains an invalid video.', {
        itemIndex: itemIndex
      });
    assert(!videoIDs.has(item.videoId), 'INVALID_SHARE_FULFILLMENT',
      'The Share fulfillment contains the same video more than once.', {videoId: item.videoId});
    assert(requestedKindIDs.has(item.requestedKindId), 'INVALID_SHARE_FULFILLMENT',
      'A shared video refers to an unknown requested kind.', {
        videoId: item.videoId,
        requestedKindId: item.requestedKindId
      });
    assert(typeof item.sourceKind === 'string' && normalizeKind(item.sourceKind) !== '',
      'INVALID_SHARE_FULFILLMENT', 'A shared video is missing its source kind.', {
        videoId: item.videoId
      });
    item.sourceKind = normalizeKind(item.sourceKind);
    assert(typeof item.requestedKindLabel === 'string' && normalizeKind(item.requestedKindLabel) !== '',
      'INVALID_SHARE_FULFILLMENT', 'A shared video is missing its requested kind.', {
        videoId: item.videoId
      });
    item.requestedKindLabel = normalizeKind(item.requestedKindLabel);
    assert(typeof item.dvd === 'boolean', 'INVALID_SHARE_FULFILLMENT',
      'A shared video has an invalid DVD marker.', {videoId: item.videoId});
    item.destinationRelativePath = validatePortableRelativePath(item.destinationRelativePath);
    item.packageDirectory = validatePortableRelativePath(item.packageDirectory);
    assert(item.packageDirectory.startsWith(`${FILES_DIRECTORY}/`),
      'INVALID_SHARE_FULFILLMENT', 'A shared video has an invalid package directory.', {
        videoId: item.videoId,
        packageDirectory: item.packageDirectory
      });
    const packageDirectoryKey = item.packageDirectory.toLowerCase();
    assert(!packageDirectories.has(packageDirectoryKey), 'INVALID_SHARE_FULFILLMENT',
      'Two shared videos use the same package directory.', {
        videoId: item.videoId,
        packageDirectory: item.packageDirectory
      });
    assert(Array.isArray(item.files) && item.files.length > 0,
      'INVALID_SHARE_FULFILLMENT', 'A shared video does not contain any files.', {
        videoId: item.videoId
      });
    const packagePaths = new Set();
    const destinationPaths = new Set();
    item.files.forEach((file, fileIndex) => {
      validateManifestFile(file, itemIndex, fileIndex);
      const packagePathKey = file.packagePath.toLowerCase();
      const destinationPathKey = file.destinationRelativePath.toLowerCase();
      assert(!packagePaths.has(packagePathKey), 'INVALID_SHARE_FULFILLMENT',
        'A shared video contains the same package file more than once.', {
          videoId: item.videoId,
          packagePath: file.packagePath
        });
      assert(!destinationPaths.has(destinationPathKey), 'INVALID_SHARE_FULFILLMENT',
        'A shared video contains the same destination file more than once.', {
          videoId: item.videoId,
          destinationPath: file.destinationRelativePath
        });
      packagePaths.add(packagePathKey);
      destinationPaths.add(destinationPathKey);
      const withinItem = path.posix.relative(item.packageDirectory, file.packagePath);
      assert(withinItem !== '' && withinItem !== '..' && !withinItem.startsWith('../') &&
          !path.posix.isAbsolute(withinItem),
        'INVALID_SHARE_FULFILLMENT', 'A Share file is outside its package item.', {
          videoId: item.videoId,
          packagePath: file.packagePath
        });
      if (file.role === 'dvd-content') {
        const withinDvd = path.posix.relative(item.destinationRelativePath, file.destinationRelativePath);
        assert(withinDvd !== '' && withinDvd !== '..' && !withinDvd.startsWith('../') &&
            !path.posix.isAbsolute(withinDvd),
          'INVALID_SHARE_FULFILLMENT', 'A DVD file is outside its destination folder.', {
            videoId: item.videoId,
            destinationPath: file.destinationRelativePath
          });
      }
    });
    assert(item.files.every(file => item.dvd ? file.role !== 'video' : file.role !== 'dvd-content'),
      'INVALID_SHARE_FULFILLMENT', 'A shared video has file roles that do not match its media type.', {
        videoId: item.videoId
      });
    const primaryFiles = item.files.filter(file =>
      file.role === (item.dvd ? 'dvd-content' : 'video')
    );
    assert(primaryFiles.length > 0 && (item.dvd || primaryFiles.length === 1),
      'INVALID_SHARE_FULFILLMENT', 'A shared video has an invalid primary-file list.', {
        videoId: item.videoId
      });
    if (!item.dvd) {
      assert(primaryFiles[0].destinationRelativePath === item.destinationRelativePath,
        'INVALID_SHARE_FULFILLMENT', 'A shared video has a mismatched primary destination.', {
          videoId: item.videoId
        });
    }
    assert(Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0,
      'INVALID_SHARE_FULFILLMENT', 'A shared video has an invalid total size.', {
        videoId: item.videoId,
        totalBytes: item.totalBytes
      });
    assert(item.totalBytes === item.files.reduce((sum, file) => sum + file.size, 0),
      'INVALID_SHARE_FULFILLMENT', 'A shared video has a mismatched total size.', {
        videoId: item.videoId,
        totalBytes: item.totalBytes
      });
    videoIDs.add(item.videoId);
    packageDirectories.add(packageDirectoryKey);
  });

  if (typeof fulfillment.omissions !== 'undefined') {
    assert(Array.isArray(fulfillment.omissions), 'INVALID_SHARE_FULFILLMENT',
      'The Share fulfillment has an invalid omissions list.');
  }
}

function validateImports(imports) {
  assert(Array.isArray(imports), 'INVALID_SHARE_MANIFEST',
    'The Share manifest has an invalid import history.');
  imports.forEach((entry, index) => {
    assert(isPlainObject(entry) && typeof entry.importingLibraryId === 'string' &&
        entry.importingLibraryId !== '',
      'INVALID_SHARE_MANIFEST', 'The Share manifest contains an invalid import record.', {
        index: index
      });
    assert(typeof entry.importedAt === 'string' && !Number.isNaN(Date.parse(entry.importedAt)),
      'INVALID_SHARE_MANIFEST', 'A Share import record has an invalid date.', {index: index});
    assert(['complete', 'partial', 'canceled'].includes(entry.status),
      'INVALID_SHARE_MANIFEST', 'A Share import record has an invalid status.', {index: index});
    assert(Number.isSafeInteger(entry.readyForScan) && entry.readyForScan >= 0 &&
        Number.isSafeInteger(entry.failedVideos) && entry.failedVideos >= 0,
      'INVALID_SHARE_MANIFEST', 'A Share import record has invalid result counts.', {index: index});
  });
}

function validateManifest(rawManifest) {
  assert(isPlainObject(rawManifest), 'INVALID_SHARE_MANIFEST',
    'This directory does not contain a valid Mynda Share request.');
  const manifest = cloneJSON(rawManifest);
  assert(manifest.format === SHARE_FORMAT, 'INVALID_SHARE_MANIFEST',
    'This file is not a Mynda Share request.', {format: manifest.format});
  assert(manifest.version === SHARE_VERSION, 'UNSUPPORTED_SHARE_VERSION',
    `This Share request uses unsupported format version ${manifest.version}.`, {
      supportedVersion: SHARE_VERSION,
      foundVersion: manifest.version
    });
  assert(Number.isSafeInteger(manifest.revision) && manifest.revision >= 1,
    'INVALID_SHARE_MANIFEST', 'The Share manifest has an invalid revision number.');
  assert(isPlainObject(manifest.request), 'INVALID_SHARE_REQUEST',
    'The Share request section is missing.');
  assert(typeof manifest.request.id === 'string' && manifest.request.id !== '',
    'INVALID_SHARE_REQUEST', 'The Share request is missing its identifier.');
  assert(typeof manifest.request.requestingLibraryId === 'string' &&
      manifest.request.requestingLibraryId !== '',
    'INVALID_SHARE_REQUEST', 'The Share request is missing its library identifier.');
  assert(typeof manifest.request.createdAt === 'string' &&
      !Number.isNaN(Date.parse(manifest.request.createdAt)),
    'INVALID_SHARE_REQUEST', 'The Share request has an invalid creation date.');
  assert(typeof manifest.request.includeDvds === 'boolean',
    'INVALID_SHARE_REQUEST', 'The Share request has an invalid DVD preference.');
  const requestedKindIDs = validateRequestedKinds(manifest.request.requestedKinds);
  validateInventory(manifest.request.inventory);
  validateFulfillment(manifest.fulfillment, requestedKindIDs);
  if (manifest.fulfillment) {
    const requestedLabels = new Map(
      manifest.request.requestedKinds.map(kind => [kind.id, kind.label])
    );
    manifest.fulfillment.items.forEach(item => {
      assert(requestedLabels.get(item.requestedKindId) === item.requestedKindLabel,
        'INVALID_SHARE_FULFILLMENT', 'A shared video has a mismatched requested kind.', {
          videoId: item.videoId,
          requestedKindId: item.requestedKindId,
          requestedKindLabel: item.requestedKindLabel
        });
    });
  }
  validateImports(manifest.imports || []);
  manifest.imports = manifest.imports || [];
  return manifest;
}

async function readManifest(directory) {
  const filePath = manifestPath(directory);
  let contents;
  try {
    contents = await fs.promises.readFile(filePath, 'utf8');
  } catch(err) {
    if (err.code === 'ENOENT') {
      fail('SHARE_REQUEST_NOT_FOUND',
        `No ${MANIFEST_FILENAME} file was found in the selected directory.`, {path: filePath});
    }
    fail('SHARE_REQUEST_UNREADABLE', 'Mynda could not read the Share request.', {
      path: filePath,
      error: err.message
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch(err) {
    fail('INVALID_SHARE_MANIFEST', 'The Share request is not valid JSON.', {
      path: filePath,
      error: err.message
    });
  }
  return validateManifest(parsed);
}

async function syncFile(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
}

async function writeManifest(directory, manifest) {
  const validated = validateManifest(manifest);
  const filePath = manifestPath(directory);
  await fs.promises.mkdir(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const contents = `${JSON.stringify(validated, null, 2)}\n`;

  try {
    await fs.promises.writeFile(temporaryPath, contents, {encoding: 'utf8', flag: 'wx'});
    await syncFile(temporaryPath);
    try {
      await fs.promises.rename(temporaryPath, filePath);
    } catch(err) {
      // Windows does not consistently replace an existing file with rename().
      // Keep a recoverable sibling while performing the fallback replacement.
      if (!['EEXIST', 'EPERM'].includes(err.code)) throw err;
      const previousPath = `${filePath}.previous`;
      try { await fs.promises.unlink(previousPath); } catch(unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
      await fs.promises.rename(filePath, previousPath);
      try {
        await fs.promises.rename(temporaryPath, filePath);
      } catch(replaceErr) {
        try { await fs.promises.rename(previousPath, filePath); } catch(restoreErr) {}
        throw replaceErr;
      }
      // The new manifest is already safely in place. A removable filesystem
      // that momentarily refuses to delete the recoverable previous copy must
      // not make the completed write look like a failure.
      try { await fs.promises.unlink(previousPath); } catch(cleanupErr) {}
    }
  } catch(err) {
    try { await fs.promises.unlink(temporaryPath); } catch(cleanupErr) {}
    if (err instanceof ShareManifestError) throw err;
    fail('SHARE_MANIFEST_WRITE_FAILED', 'Mynda could not save the Share request.', {
      path: filePath,
      error: err.message
    });
  }
  return filePath;
}

module.exports = {
  SHARE_FORMAT,
  SHARE_VERSION,
  MANIFEST_FILENAME,
  FILES_DIRECTORY,
  IMPORT_STAGING_DIRECTORY,
  ShareManifestError,
  normalizeKind,
  manifestPath,
  validatePortableRelativePath,
  toPortableRelativePath,
  safeJoin,
  validateManifest,
  readManifest,
  writeManifest
};
