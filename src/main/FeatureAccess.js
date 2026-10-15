'use strict';
const {createFeatureAccess} = require('../platform/FeatureAccess');
const connection = require('./MetadataConnection');

module.exports = createFeatureAccess({requireActivation:()=>connection.requireActivation()});
