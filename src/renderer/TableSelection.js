// Data-only selection helpers for virtualized library tables. Selection must
// not depend on which rows happen to be mounted in the DOM: offscreen rows and
// rows inside collapsed series remain part of the same batch.

function groupRows(group) {
  return group && Array.isArray(group.rows) ? group.rows : [];
}

function unique(values) {
  return Array.from(new Set(values));
}

function cloneSelection(selectedRows) {
  const clone = {};
  Object.keys(selectedRows || {}).forEach(tableID => {
    const group = selectedRows[tableID];
    const rows = unique(groupRows(group));
    if (rows.length > 0) {
      clone[tableID] = {
        rows: rows,
        highestRow: group.highestRow || null
      };
    }
  });
  return clone;
}

function allSelectedVideoIDs(selectedRows) {
  const selected = [];
  Object.keys(selectedRows || {}).forEach(tableID => {
    selected.push(...groupRows(selectedRows[tableID]));
  });
  return unique(selected);
}

// Return this table's selection in current table order. Looking through every
// group also supports the defensive `series-edit` group used while manifests
// are still being assembled.
function selectedVideoIDsForTable(selectedRows, tableRows) {
  const selected = new Set(allSelectedVideoIDs(selectedRows));
  return (tableRows || [])
    .map(row => row && row.vidID)
    .filter(id => id && selected.has(id));
}

// Calculate a click's local-table selection from the complete sorted data,
// never from mounted row elements. Shift ranges can therefore include rows
// above or below the viewport.
function selectTableRow(tableRows, selectedVideoIDs, clickedVideoID, clickedIndex, options = {}) {
  const rows = Array.isArray(tableRows) ? tableRows : [];
  const selected = unique(Array.isArray(selectedVideoIDs) ? selectedVideoIDs : []);
  let end = Number.isInteger(clickedIndex) ? clickedIndex :
    rows.findIndex(row => row && row.vidID === clickedVideoID);

  if (end < 0 || end >= rows.length) {
    return {selectedVideoIDs: selected, overwrite: false, deferClear: false};
  }

  if (options.shift) {
    const selectedSet = new Set(selected);
    let start = end;
    let smallestDifference = rows.length + 1;

    rows.forEach((row, index) => {
      if (!row || !selectedSet.has(row.vidID)) return;
      const difference = Math.abs(end - index);
      if (difference < smallestDifference) {
        smallestDifference = difference;
        start = index;
      }
    });

    const low = Math.min(start, end);
    const high = Math.max(start, end);
    return {
      selectedVideoIDs: rows.slice(low, high + 1).map(row => row.vidID),
      overwrite: false,
      deferClear: false
    };
  }

  if (options.toggle) {
    const selectedSet = new Set(selected);
    if (selectedSet.has(clickedVideoID)) {
      selectedSet.delete(clickedVideoID);
    } else {
      selectedSet.add(clickedVideoID);
    }
    return {
      selectedVideoIDs: rows
        .map(row => row && row.vidID)
        .filter(id => id && selectedSet.has(id)),
      overwrite: false,
      deferClear: false
    };
  }

  if (!options.forceSelect && selected.length === 1 && selected[0] === clickedVideoID) {
    return {selectedVideoIDs: selected, overwrite: true, deferClear: true};
  }

  return {
    selectedVideoIDs: [clickedVideoID],
    overwrite: true,
    deferClear: false
  };
}

// Return a new selection object. When a table reports its selection, remove
// that table's video IDs from every prior group first. This canonicalizes IDs
// that may temporarily live in the synthetic whole-series group and prevents
// duplicate or impossible-to-deselect entries.
function mergeTableSelection(selectedRows, selectedVideoIDs, highestRow, tableID, overwrite, tableVideoIDs) {
  const next = overwrite ? {} : cloneSelection(selectedRows);
  const tableIDSet = new Set(Array.isArray(tableVideoIDs) ? tableVideoIDs : []);

  if (!overwrite && tableIDSet.size > 0) {
    Object.keys(next).forEach(existingTableID => {
      const remaining = groupRows(next[existingTableID])
        .filter(videoID => !tableIDSet.has(videoID));
      if (remaining.length > 0) {
        next[existingTableID] = {...next[existingTableID], rows: remaining};
      } else {
        delete next[existingTableID];
      }
    });
  }

  const rows = unique(Array.isArray(selectedVideoIDs) ? selectedVideoIDs : []);
  if (tableID && rows.length > 0) {
    next[tableID] = {rows: rows, highestRow: highestRow || null};
  }

  return next;
}

function summarizeSelection(selectedRows, playlistRowManifest) {
  const rows = allSelectedVideoIDs(selectedRows);
  const selected = new Set(rows);
  const firstManifestRow = (playlistRowManifest || [])
    .find(row => row && selected.has(row.vidID));

  return {
    rows: rows,
    highestRow: firstManifestRow ? firstManifestRow.rowID : null
  };
}

module.exports = {
  allSelectedVideoIDs,
  cloneSelection,
  mergeTableSelection,
  selectTableRow,
  selectedVideoIDsForTable,
  summarizeSelection
};
