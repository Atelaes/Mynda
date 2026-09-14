const path = require('path');
const {spawn} = require('child_process');
const catalog = require('./TestCatalog.js');

const projectRoot = path.resolve(__dirname, '..');
const aliases = {
  fast: 'fast',
  core: 'core',
  unit: 'unit',
  integration: 'integration',
  component: 'component',
  renderer: 'component',
  e2e: 'end-to-end',
  electron: 'end-to-end',
  all: 'all',
  list: 'list'
};

function usage() {
  console.log('Usage: node test/run-tests.js [fast|core|unit|integration|component|e2e|all|list]');
}

function printCatalog() {
  const categoryWidth = Math.max(...catalog.map(entry => entry.category.length));
  const titleWidth = Math.max(...catalog.map(entry => entry.title.length));
  console.log('\nMynda automated test catalog\n');
  catalog.forEach(entry => {
    console.log(
      `${entry.category.padEnd(categoryWidth)}  ${entry.title.padEnd(titleWidth)}  ${entry.file}`
    );
    console.log(`${' '.repeat(categoryWidth + titleWidth + 4)}${entry.protects}${entry.requiresMediaTools ? ' (requires installed media tools)' : ''}`);
  });
  console.log('\n`fast` runs unit + integration + component tests. `all` adds real Electron.');
  console.log('`core` runs the fast suites that do not require media executables.');
}

function parseResult(output, entry, exitCode) {
  const marker = output.split(/\r?\n/)
    .filter(line => line.startsWith('MYNDA_TEST_RESULT:'))
    .pop();
  if (marker) {
    try {
      return JSON.parse(marker.slice('MYNDA_TEST_RESULT:'.length));
    } catch(err) {}
  }
  return {
    suite: entry.title,
    category: entry.category,
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode === 0 ? 0 : 1,
    total: 1,
    groupedLegacySuite: true
  };
}

function runEntry(entry) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(projectRoot, entry.file), ...(entry.args || [])], {
      cwd: projectRoot,
      env: Object.assign({}, process.env, {BROWSERSLIST_IGNORE_OLD_DATA: 'true'}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', data => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', data => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });
    child.once('error', error => {
      console.error(`Could not start ${entry.file}: ${error.stack || error}`);
      resolve({
        entry,
        exitCode: 1,
        result: {category: entry.category, passed: 0, failed: 1, total: 1}
      });
    });
    child.once('close', exitCode => {
      resolve({entry, exitCode, result: parseResult(output, entry, exitCode)});
    });
  });
}

async function main() {
  const requested = (process.argv[2] || 'fast').toLowerCase();
  const mode = aliases[requested];
  if (!mode) {
    console.error(`Unknown test group: ${requested}`);
    usage();
    process.exitCode = 2;
    return;
  }
  if (mode === 'list') {
    printCatalog();
    return;
  }

  const selected = catalog.filter(entry => {
    if (mode === 'all') return true;
    if (mode === 'core') return entry.category !== 'end-to-end' && !entry.requiresMediaTools;
    if (mode === 'fast') return entry.category !== 'end-to-end';
    return entry.category === mode;
  });
  console.log(`Running ${selected.length} Mynda test suite${selected.length === 1 ? '' : 's'} (${requested})...`);
  if (mode === 'core') {
    console.log('The two real-media suites are not selected. Run npm test after npm run media:prepare for full fast coverage.');
  }

  const runs = [];
  for (const entry of selected) {
    runs.push(await runEntry(entry));
  }

  const failedSuites = runs.filter(run => run.exitCode !== 0 || run.result.failed > 0);
  const totalCases = runs.reduce((sum, run) => sum + (run.result.total || 0), 0);
  const passedCases = runs.reduce((sum, run) => sum + (run.result.passed || 0), 0);
  console.log('\nMynda test summary');
  console.log(`  Suites: ${runs.length - failedSuites.length}/${runs.length} passed`);
  console.log(`  Cases:  ${passedCases}/${totalCases} passed`);

  const categories = [...new Set(runs.map(run => run.entry.category))];
  categories.forEach(category => {
    const categoryRuns = runs.filter(run => run.entry.category === category);
    const categoryFailures = categoryRuns.filter(run => run.exitCode !== 0 || run.result.failed > 0);
    console.log(
      `  ${category}: ${categoryRuns.length - categoryFailures.length}/${categoryRuns.length} suites passed`
    );
  });

  if (failedSuites.length > 0) {
    console.error('\nFailed suites:');
    failedSuites.forEach(run => console.error(`  ${run.entry.file}${run.entry.args ? ' ' + run.entry.args.join(' ') : ''}`));
    process.exitCode = 1;
  } else {
    console.log('\nPASS: every selected Mynda test suite passed.');
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
