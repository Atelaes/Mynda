'use strict';

// Product restrictions live here, independently of catalog providers and UI.
// A new restricted feature registers its policy and calls requireFeature before
// starting work. Only the main process supplies the activation authority.
const FEATURES = Object.freeze({tagging:Object.freeze({label:'tagging',requiresActivation:true})});
const ACCESS_CODES = new Set(['ACTIVATION_REQUIRED','ACTIVATION_REJECTED',
  'ACTIVATION_UNAVAILABLE','ACTIVATION_CHECK_FAILED']);
const isFeatureAccessError = error => Boolean(error && ACCESS_CODES.has(error.code));

function accessError(feature, cause) {
  const label = FEATURES[feature].label;
  let code = 'ACTIVATION_UNAVAILABLE';
  let message = `Mynda could not read its activation details. Open Settings → License before using ${label}.`;
  if (cause && cause.code === 'ACCESS_MISSING') {
    code = 'ACTIVATION_REQUIRED';
    message = `Activate Mynda to use ${label}. Open Settings → License and enter your license key.`;
  } else if (cause && ['ACCESS_REJECTED','UNAUTHORIZED'].includes(cause.code)) {
    code = 'ACTIVATION_REJECTED';
    message = `Mynda’s license key was not accepted. Open Settings → License to check activation before using ${label}.`;
  } else if (cause && cause.code === 'CONNECTION_FAILED') {
    code = 'ACTIVATION_CHECK_FAILED';
    message = `Mynda could not reach the activation service to verify your saved license key. Check your internet connection and try ${label} again. Your key has not been removed.`;
  } else if (cause && cause.code === 'STORAGE_LOCKED') {
    message = 'Mynda could not check activation because secure credential storage is unavailable. Unlock your system keychain or enable a desktop keyring, then restart Mynda.';
  }
  // Never carry credential values or an underlying HTTP error into IPC/logs.
  return Object.assign(new Error(message), {name:'FeatureAccessError',code,feature});
}

function createFeatureAccess({requireActivation}) {
  async function requireFeature(feature) {
    if (!Object.hasOwn(FEATURES, feature)) throw new TypeError('Unknown feature access policy.');
    if (!FEATURES[feature].requiresActivation) return;
    try { await requireActivation(); }
    catch (error) { throw accessError(feature,error); }
  }
  function protect(feature, operation) {
    return async (...args) => {
      await requireFeature(feature);
      const result = await operation(...args);
      // Removal or service rejection during a lookup also invalidates a cached
      // proposal/result. It must not become a per-video failure or saved tags.
      await requireFeature(feature);
      if (result && result.reason && result.reason.code === 'UNAUTHORIZED') {
        throw accessError(feature,result.reason);
      }
      return result;
    };
  }
  return {requireFeature,protect};
}

module.exports = {FEATURES,createFeatureAccess,isFeatureAccessError};
