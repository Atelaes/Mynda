// Resource policy. Strategy sizes limit discovery breadth; the request layer
// separately enforces the total number of actual HTTP calls for one operation.
module.exports = Object.freeze({
  networkPerOperation:96, cachedResponses:4096, timeoutMs:20000, saveBatchSize:10,
  movie:Object.freeze({titleQueries:8, normalizedQueries:2, detailCandidates:7}),
  series:Object.freeze({queryForms:6, fallbackRequests:12, pages:3, candidates:3, structureCandidates:10, representatives:3}),
  episode:Object.freeze({nearbyDistances:Object.freeze([1,2]),adjacentSeasonOffsets:Object.freeze([-1,1])})
});
