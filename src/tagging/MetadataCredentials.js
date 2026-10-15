'use strict';
const fs = require('fs').promises;
const path = require('path');
const {randomUUID} = require('crypto');
const {validateServerConfig, defaultServerURL} = require('./MetadataServerConfig');

const messages = {
  STORAGE_LOCKED: 'Secure credential storage is unavailable. Unlock your system keychain or enable a desktop keyring, then restart Mynda.',
  STORAGE_READ: 'Mynda could not unlock the saved license key. Check your system keychain or enter the key again.',
  STORAGE_WRITE: 'Mynda could not save the activation details. Check available disk space and folder permissions.',
  INVALID_CREDENTIAL: 'Enter a valid license key. If you changed the development server, use HTTPS or HTTP on localhost.',
  ALREADY_CONFIGURED: 'A license key is already saved. Use Settings → License to replace it.',
  ACCESS_REJECTED: 'The activation service did not accept this license key. Check the key and try again.',
  CONNECTION_FAILED: 'Mynda could not reach or verify the activation service. Check your internet connection and try again.',
  ACCESS_MISSING: 'Open Settings → License to activate Mynda with your license key.',
  LEGACY_INVALID: 'The old connection file is invalid. Enter your license key in Settings → License.',
  LEGACY_REMOVE: 'Your license key is saved securely, but the old metadata-server.local.json file could not be removed. Remove that old file manually.',
};
function failure(code) { return Object.assign(new Error(messages[code]), {code}); }

// Nothing from Axios (including headers or echoed response bodies) crosses this
// boundary. Capabilities validates access without spending provider requests.
async function verifyConnection(axios, config) {
  let response;
  try {
    response = await axios({method:'get', url:config.url + '/v1/capabilities',
      headers:{Authorization:`Bearer ${config.token}`}, timeout:15000,
      maxRedirects:0, maxContentLength:65536, proxy:false, validateStatus:()=>true});
  } catch (_) { throw failure('CONNECTION_FAILED'); }
  if (response.status === 401 || response.status === 403) throw failure('ACCESS_REJECTED');
  const data = response.data;
  if (response.status !== 200 || !data || typeof data.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(data.requestId) || !data.data ||
      typeof data.data.provider !== 'string' || !data.data.provider) throw failure('CONNECTION_FAILED');
}

function createCredentialStore({userData, safeStorage, ready = async()=>{}, platform = process.platform,
  legacyFile, allowServerOverride = false, verify, io = fs}) {
  const directory = path.join(userData, 'connection');
  const file = path.join(directory, 'metadata-credentials.json');
  let current = null, problem = null, checked = false, rejected = false, initialized, tail = Promise.resolve();
  let reEncrypt = false;
  const status = () => ({hasCredential:Boolean(current), verified:checked,
    url:current ? current.url : defaultServerURL, defaultURL:defaultServerURL,
    allowServerOverride, message:problem ? messages[problem] : null});

  async function available() {
    try {
      await ready();
      if (!safeStorage) throw new Error();
      // Electron's basic_text fallback is not a private OS key. Never use it.
      if (platform === 'linux' && !['gnome_libsecret','kwallet','kwallet5','kwallet6']
        .includes(safeStorage.getSelectedStorageBackend())) throw new Error();
      const ok = safeStorage.isAsyncEncryptionAvailable ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
      if (!ok) throw new Error();
    } catch (_) { throw failure('STORAGE_LOCKED'); }
  }
  async function decrypt(bytes) {
    if (safeStorage.decryptStringAsync) {
      const result = await safeStorage.decryptStringAsync(bytes);
      reEncrypt = result.shouldReEncrypt === true;
      return result.result;
    }
    return safeStorage.decryptString(bytes);
  }
  async function write(record) {
    let handle;
    const temporary = path.join(directory, `.metadata-credentials-${randomUUID()}.tmp`);
    try {
      await io.mkdir(directory, {recursive:true, mode:0o700});
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n');
      await handle.sync();
      await handle.close(); handle = null;
      await io.rename(temporary, file);
    } catch (_) { throw failure('STORAGE_WRITE'); }
    finally {
      if (handle) await handle.close().catch(()=>{});
      await io.unlink(temporary).catch(()=>{});
    }
  }
  async function persist(config) {
    await available();
    let encrypted;
    try {
      const plain = JSON.stringify(config);
      encrypted = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(plain) : safeStorage.encryptString(plain);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 16384 ||
          await decrypt(encrypted) !== plain) throw new Error();
    } catch (_) { throw failure('STORAGE_WRITE'); }
    await write({version:1, encrypted:encrypted.toString('base64')});
  }
  async function removeLegacy(contents) {
    try {
      // Do not remove a file edited while encryption or validation was pending.
      if (await io.readFile(legacyFile, 'utf8') !== contents) { problem = 'LEGACY_REMOVE'; return; }
      await io.unlink(legacyFile);
    } catch (error) { if (error.code !== 'ENOENT') problem = 'LEGACY_REMOVE'; }
  }
  async function initialize() {
    await ready();
    let record;
    try {
      const info = await io.stat(file);
      if (info.size > 32768) throw new Error();
      record = JSON.parse(await io.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') { problem = 'STORAGE_READ'; return; }
    }
    if (record !== undefined) {
      if (!record || record.version !== 1) { problem = 'STORAGE_READ'; return; }
      // A removal marker prevents a leftover legacy file being reimported.
      if (record.removed === true && record.encrypted === undefined) return;
      try {
        await available();
        if (typeof record.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.encrypted)) throw new Error();
        current = validateServerConfig(JSON.parse(await decrypt(Buffer.from(record.encrypted, 'base64'))));
        if (reEncrypt) await persist(current);
      } catch (error) { problem = ['STORAGE_LOCKED','STORAGE_WRITE'].includes(error.code) ? error.code : 'STORAGE_READ'; }
      return;
    }
    if (!legacyFile) return;
    let contents, config;
    try {
      if ((await io.stat(legacyFile)).size > 4096) throw new Error();
      contents = await io.readFile(legacyFile, 'utf8');
      config = validateServerConfig(JSON.parse(contents));
    } catch (error) {
      if (error.code !== 'ENOENT') problem = 'LEGACY_INVALID';
      return;
    }
    try {
      await persist(config);
      // Verify the committed file before retiring the plaintext source.
      const saved = JSON.parse(await io.readFile(file, 'utf8'));
      if (await decrypt(Buffer.from(saved.encrypted, 'base64')) !== JSON.stringify(config)) throw failure('STORAGE_WRITE');
      current = config;
      await removeLegacy(contents);
    } catch (error) { problem = error.code === 'STORAGE_LOCKED' ? 'STORAGE_LOCKED' : 'STORAGE_WRITE'; }
  }
  function init() { return initialized || (initialized = initialize().catch(()=>{problem = 'STORAGE_READ';})); }
  function exclusive(operation) {
    const task = tail.then(async()=>{await init(); return operation();});
    tail = task.catch(()=>{});
    return task;
  }
  function parsed(input) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key=>!['url','token'].includes(key))) throw new Error();
      return validateServerConfig({url:input.url || defaultServerURL,
        token:typeof input.token === 'string' ? input.token.trim() : input.token});
    } catch (_) { throw failure('INVALID_CREDENTIAL'); }
  }
  function requireCurrent() {
    if (!current) throw failure(problem && problem !== 'LEGACY_REMOVE' ? problem : 'ACCESS_MISSING');
  }
  async function check() {
    requireCurrent();
    try { await verify(current); checked = true; rejected = false; return status(); }
    catch (error) {
      checked = false;
      if (error.code === 'ACCESS_REJECTED') rejected = true;
      throw error;
    }
  }
  async function save(input, {check = true, onlyIfMissing = false} = {}) {
    return exclusive(async()=>{
      if (onlyIfMissing && current) throw failure('ALREADY_CONFIGURED');
      const config = parsed(input);
      if (!allowServerOverride && config.url !== defaultServerURL && config.url !== (current && current.url)) throw failure('INVALID_CREDENTIAL');
      await available();
      if (check) await verify(config);
      await persist(config);
      current = config; checked = check; rejected = false; problem = null;
      return status();
    });
  }
  return {
    file,
    async getStatus() { await tail; await init(); return status(); },
    async getConfig() {
      await tail; await init();
      requireCurrent();
      if (rejected) throw failure('ACCESS_REJECTED');
      return {...current};
    },
    save,
    check: () => exclusive(check),
    // Verification is session-local. A restored key is checked before the
    // first restricted operation; later calls only consult local state.
    // Serializing with save/remove prevents an in-flight check restoring access.
    requireActivation: () => exclusive(async()=>{
      requireCurrent();
      if (rejected) throw failure('ACCESS_REJECTED');
      if (!checked) await check();
    }),
    reject: config => exclusive(()=>{
      // An old request must not invalidate a replacement key or server.
      if (current && current.url === config.url && current.token === config.token) {
        checked = false; rejected = true;
      }
    }),
    remove: () => exclusive(async()=>{
      await write({version:1, removed:true});
      current = null; checked = false; rejected = false; problem = null;
      return status();
    }),
    changeServer: url => exclusive(async()=>{
      if (!current) throw failure('ACCESS_MISSING');
      const next = parsed({url, token:current.token});
      if (!allowServerOverride) throw failure('INVALID_CREDENTIAL');
      await persist(next);
      current = next; checked = false; rejected = false; problem = null;
      return status();
    }),
  };
}
module.exports = {createCredentialStore, verifyConnection, messages};
