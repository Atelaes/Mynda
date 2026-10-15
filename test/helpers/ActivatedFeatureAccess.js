// Matching/transport fixtures explicitly start with valid activation. The
// credential lifecycle and blocked entry points have separate integration tests.
module.exports = require('../../src/platform/FeatureAccess').createFeatureAccess({requireActivation:async()=>{}});
