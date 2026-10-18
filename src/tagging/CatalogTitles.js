// Only provider-supplied names are identity evidence. Query spellings and
// shortened discovery phrases must never enter this list.
const Identity = require('./CatalogIdentity');
function names(record) {
  return [...new Set([record && record.Title,...(Array.isArray(record && record.catalogAliases) ?
    record.catalogAliases : [])].filter(name => typeof name === 'string' && name.trim()))];
}
function merge(record, summary) {
  if (!Identity.recordKey(record) || Identity.recordKey(record) !== Identity.recordKey(summary)) return record;
  return {...record,catalogAliases:[...new Set([...names(record),...names(summary)])].filter(name=>name!==record.Title)};
}
module.exports = {names,merge};
