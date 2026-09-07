const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

class TestSuite {
  constructor(name, category, description) {
    this.name = name;
    this.category = category;
    this.description = description || '';
    this.tests = [];
  }

  test(name, operation) {
    this.tests.push({name, operation});
    return this;
  }

  async run() {
    const started = Date.now();
    let passed = 0;
    const failures = [];

    console.log(`\n[${this.category.toUpperCase()}] ${this.name}`);
    if (this.description) console.log(`  ${this.description}`);

    for (const test of this.tests) {
      try {
        await test.operation();
        passed++;
        console.log(`  PASS  ${test.name}`);
      } catch(err) {
        failures.push({name: test.name, error: err});
        console.error(`  FAIL  ${test.name}`);
        console.error(indent(err && err.stack ? err.stack : String(err), 8));
      }
    }

    const result = {
      suite: this.name,
      category: this.category,
      passed,
      failed: failures.length,
      total: this.tests.length,
      durationMs: Date.now() - started
    };
    console.log(`  ${passed}/${this.tests.length} tests passed (${result.durationMs} ms)`);
    console.log(`MYNDA_TEST_RESULT:${JSON.stringify(result)}`);

    if (failures.length > 0) {
      const error = new Error(`${failures.length} test${failures.length === 1 ? '' : 's'} failed in ${this.name}`);
      error.failures = failures;
      throw error;
    }
    return result;
  }
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(value).split('\n').map(line => `${prefix}${line}`).join('\n');
}

function createSuite(name, category, description) {
  return new TestSuite(name, category, description);
}

function runSuite(suite) {
  suite.run().catch(() => {
    process.exitCode = 1;
  });
}

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mynda-${label}-`));
}

function removeDirectory(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(directory, {recursive: true, force: true});
    return;
  }
  for (const entry of fs.readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const stats = fs.lstatSync(entryPath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) removeDirectory(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(directory);
}

async function withTemporaryDirectory(label, operation) {
  const directory = temporaryDirectory(label);
  try {
    return await operation(directory);
  } finally {
    removeDirectory(directory);
  }
}

async function rejectsWithCode(operation, code) {
  let thrown = null;
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch(err) {
    thrown = err;
  }
  assert(thrown, `Expected rejection with code ${code}`);
  assert.strictEqual(thrown.code, code);
  return thrown;
}

module.exports = {
  assert,
  createSuite,
  runSuite,
  temporaryDirectory,
  removeDirectory,
  withTemporaryDirectory,
  rejectsWithCode
};
