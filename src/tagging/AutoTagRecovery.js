// Compatibility entry point; parent recovery and order review share one ledger.
const {createEvidence} = require('./BatchEvidence');
module.exports = {createRecovery:createEvidence};
