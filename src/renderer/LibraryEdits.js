// A renderer edit carries only the fields the user changed. Its original
// snapshot remains attached for conflict checks against the latest store state.
const _ = require('lodash');

function videoEdit(original, edited, comparison = original) {
  const changes = {};
  const expected = {};
  function visit(before, after, prefix) {
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
      if (!prefix && (key === 'id' || key.startsWith('__mynda_'))) continue;
      const address = prefix ? `${prefix}.${key}` : key;
      const previous = before && before[key];
      const next = after && after[key];
      if (_.isEqual(previous, next)) continue;
      // Ratings need leaf-level edits: a user rating must not replace freshly
      // downloaded catalog ratings. Other nested values retain the same rule.
      if (_.isPlainObject(previous) && _.isPlainObject(next)) {
        visit(previous, next, address);
      } else {
        changes[address] = _.cloneDeep(next);
        expected[address] = _.cloneDeep(_.get(original, address));
      }
    }
  }
  visit(comparison, edited, '');
  return {id: original.id, changes, expected, baseline: _.cloneDeep(original)};
}

function reportSaveFailure(error, log, description = 'save your changes') {
  if (!error) return;
  if (log && log.error) log.error(`Could not ${description}`, {error});
  if (error.libraryOperation && error.libraryOperation.committed) {
    if (typeof alert === 'function') alert(error.message);
    return;
  }
  const conflict = error.code === 'LIBRARY_CONFLICT' || error.code === 'MYNDA_LIBRARY_CONFLICT';
  const detail = conflict ?
    'This item changed while you were editing it. Your edit has not overwritten the newer information.' :
    error.message || String(error);
  if (typeof alert === 'function') alert(`Mynda could not ${description}. ${detail}`);
}

module.exports = {videoEdit, reportSaveFailure};
