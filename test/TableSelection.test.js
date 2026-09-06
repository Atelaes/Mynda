const assert = require('assert');
const {
  mergeTableSelection,
  selectTableRow,
  selectedVideoIDsForTable,
  summarizeSelection
} = require('../src/renderer/TableSelection.js');

const rows = Array.from({length: 5000}, (unused, index) => ({
  index: index,
  rowID: `row-${index}`,
  vidID: `video-${index}`,
  tableID: 'flat'
}));

// Shift-selection must use the full data set, including thousands of rows
// which a virtual table will not have mounted.
const offscreenRange = selectTableRow(
  rows,
  ['video-100'],
  'video-4900',
  4900,
  {shift: true}
);
assert.strictEqual(offscreenRange.selectedVideoIDs.length, 4801);
assert.strictEqual(offscreenRange.selectedVideoIDs[0], 'video-100');
assert.strictEqual(offscreenRange.selectedVideoIDs[4800], 'video-4900');
assert.strictEqual(offscreenRange.overwrite, false);

// Preserve the existing single-click/double-click contract: clicking the sole
// selected row schedules an unselect, while the second click can force it to
// remain selected before playback starts.
const deferredClear = selectTableRow(rows, ['video-4'], 'video-4', 4);
assert.strictEqual(deferredClear.deferClear, true);
const forcedSelection = selectTableRow(
  rows,
  ['video-4'],
  'video-4',
  4,
  {forceSelect: true}
);
assert.deepStrictEqual(forcedSelection.selectedVideoIDs, ['video-4']);
assert.strictEqual(forcedSelection.deferClear, false);

// A selection can span season tables, including a synthetic whole-series
// group created while some collapsed tables have not reported yet.
const original = {
  'Show.1': {rows: ['s1e1'], highestRow: 's1e1'},
  'series-edit': {rows: ['s2e1', 's2e2'], highestRow: null}
};
const seasonTwoRows = [
  {index: 0, rowID: 's2e1', vidID: 's2e1'},
  {index: 1, rowID: 's2e2', vidID: 's2e2'},
  {index: 2, rowID: 's2e3', vidID: 's2e3'}
];
assert.deepStrictEqual(
  selectedVideoIDsForTable(original, seasonTwoRows),
  ['s2e1', 's2e2']
);

const toggled = selectTableRow(
  seasonTwoRows,
  ['s2e1', 's2e2'],
  's2e2',
  1,
  {toggle: true}
);
const acrossTables = mergeTableSelection(
  original,
  toggled.selectedVideoIDs,
  's2e1',
  'Show.2',
  false,
  seasonTwoRows.map(row => row.vidID)
);
assert.deepStrictEqual(acrossTables, {
  'Show.1': {rows: ['s1e1'], highestRow: 's1e1'},
  'Show.2': {rows: ['s2e1'], highestRow: 's2e1'}
});
assert.deepStrictEqual(original['series-edit'].rows, ['s2e1', 's2e2']);

// An ordinary click replaces selections in every other table.
const overwritten = mergeTableSelection(
  acrossTables,
  ['s2e3'],
  's2e3',
  'Show.2',
  true,
  seasonTwoRows.map(row => row.vidID)
);
assert.deepStrictEqual(overwritten, {
  'Show.2': {rows: ['s2e3'], highestRow: 's2e3'}
});

// The jump target follows full playlist order, not object insertion order.
const summary = summarizeSelection(
  {
    later: {rows: ['video-30'], highestRow: 'row-30'},
    earlier: {rows: ['video-4'], highestRow: 'row-4'}
  },
  rows
);
assert.strictEqual(summary.highestRow, 'row-4');
assert.deepStrictEqual(new Set(summary.rows), new Set(['video-30', 'video-4']));

console.log('Table selection tests passed.');
