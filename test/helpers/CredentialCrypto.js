// Test-only OS boundary replacement. The production store has no plaintext or
// fixed-key fallback; real AES-GCM here exercises persistence and wrong keys.
const crypto = require('crypto');
function credentialCrypto(key = crypto.randomBytes(32)) {
  return {
    getSelectedStorageBackend:()=> 'gnome_libsecret',
    isAsyncEncryptionAvailable:async()=>true,
    async encryptStringAsync(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
    },
    async decryptStringAsync(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      return {result:Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'),shouldReEncrypt:false};
    }
  };
}
module.exports = {credentialCrypto};
