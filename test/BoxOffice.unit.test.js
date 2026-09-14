const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {
  BOX_OFFICE_CURRENCY,
  DEFAULT_BOX_OFFICE_LOCALE,
  parseBoxOffice,
  parseOmdbBoxOffice,
  formatBoxOffice,
  formatCompactBoxOffice
} = require('../src/library/BoxOffice.js');

const suite = createSuite(
  'Box-office parsing and formatting',
  'unit',
  'Keeps amounts in USD while testing safe input, compact display, and locale-aware presentation.'
);

function nativeFullFormat(locale, value) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

suite.test('defines USD as the fixed currency and en-US as the compatibility locale', () => {
  assert.strictEqual(BOX_OFFICE_CURRENCY, 'USD');
  assert.strictEqual(DEFAULT_BOX_OFFICE_LOCALE, 'en-US');
});

suite.test('parses stored numbers and ordinary U.S.-formatted USD input', () => {
  assert.strictEqual(parseBoxOffice(107928762), 107928762);
  assert.strictEqual(parseBoxOffice('107928762'), 107928762);
  assert.strictEqual(parseBoxOffice('107,928,762'), 107928762);
  assert.strictEqual(parseBoxOffice(' $107,928,762 '), 107928762);
  assert.strictEqual(parseBoxOffice('USD 107,928,762'), 107928762);
});

suite.test('accepts fractions and an explicit positive sign', () => {
  assert.strictEqual(parseBoxOffice('$1,234.56'), 1234.56);
  assert.strictEqual(parseBoxOffice('.50'), 0.5);
  assert.strictEqual(parseBoxOffice('+250'), 250);
  assert.strictEqual(parseBoxOffice(0), 0);
});

suite.test('rejects missing, negative, infinite, and non-USD text', () => {
  const invalid = ['', 'N/A', '-1', 'EUR 10', 'not money', NaN, Infinity, -Infinity, null, undefined, {}];
  invalid.forEach(value => assert.strictEqual(parseBoxOffice(value), null));
});

suite.test('normalizes OMDb values to whole USD and makes unavailable values zero', () => {
  assert.strictEqual(parseOmdbBoxOffice('$107,928,762'), 107928762);
  assert.strictEqual(parseOmdbBoxOffice('$1,234.50'), 1235);
  assert.strictEqual(parseOmdbBoxOffice('N/A'), 0);
  assert.strictEqual(parseOmdbBoxOffice(undefined), 0);
  assert.strictEqual(parseOmdbBoxOffice('-12'), 0);
});

suite.test('formats full U.S. dollar values without cents', () => {
  assert.strictEqual(formatBoxOffice(107928762), '$107,928,762');
  assert.strictEqual(formatBoxOffice('1000'), '$1,000');
  assert.strictEqual(formatBoxOffice(0), '$0');
  assert.strictEqual(formatBoxOffice(1234.75), '$1,235');
});

suite.test('uses native compact thresholds for table values', () => {
  assert.strictEqual(formatCompactBoxOffice(999), '$999');
  assert.strictEqual(formatCompactBoxOffice(1000), '$1K');
  assert.strictEqual(formatCompactBoxOffice(1500), '$1.5K');
  assert.strictEqual(formatCompactBoxOffice(999999), '$1M');
  assert.strictEqual(formatCompactBoxOffice(107928762), '$107.9M');
  assert.strictEqual(formatCompactBoxOffice(1500000000), '$1.5B');
});

suite.test('matches Intl locale conventions while retaining USD', () => {
  assert.strictEqual(
    formatBoxOffice(107928762, {locale: 'de-DE'}),
    nativeFullFormat('de-DE', 107928762)
  );
  assert.strictEqual(
    formatBoxOffice(107928762, 'fr-FR'),
    nativeFullFormat('fr-FR', 107928762)
  );
});

suite.test('round-trips German grouping, decimals, and currency placement', () => {
  const locale = 'de-DE';
  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD'
  }).format(1234.5);
  assert.strictEqual(parseBoxOffice(formatted, {locale: locale}), 1234.5);
});

suite.test('round-trips localized Arabic digits and separators', () => {
  const locale = 'ar-EG';
  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD'
  }).format(1234.5);
  assert.strictEqual(parseBoxOffice(formatted, {locale: locale}), 1234.5);
});

suite.test('falls back safely when a locale identifier is invalid', () => {
  assert.strictEqual(
    formatBoxOffice(1234, {locale: 'not_a_valid_locale'}),
    '$1,234'
  );
  assert.strictEqual(
    parseBoxOffice('$1,234', {locale: 'not_a_valid_locale'}),
    1234
  );
});

suite.test('does not interpret display options as currency conversion', () => {
  assert.strictEqual(
    formatBoxOffice(1234, {locale: 'en-US', currency: 'EUR'}),
    nativeFullFormat('en-US', 1234)
  );
  assert.strictEqual(formatBoxOffice(-1), '');
  assert.strictEqual(formatBoxOffice('N/A'), '');
  assert.strictEqual(formatCompactBoxOffice(Infinity), '');
});

runSuite(suite);
