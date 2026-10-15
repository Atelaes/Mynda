// Test-only adapter for the historical provider recordings. Production callers
// exchange structured catalog queries and never construct provider URLs.
const {createCatalogClient} = require('../../src/tagging/CatalogClient');

function legacyQuery(query) {
  const names = {id:'i',title:'s',exactTitle:'t',year:'y',type:'type',season:'Season',episode:'Episode',page:'page'};
  return Object.fromEntries(Object.entries(query).map(([name,value]) => [names[name],String(value)]));
}

function createFixtureCatalogClient(options) {
  return createCatalogClient({...options, transport:query => options.axios({
    url:'https://fixture.invalid/?' + new URLSearchParams(legacyQuery(query))
  })});
}

module.exports = {legacyQuery, createFixtureCatalogClient};
