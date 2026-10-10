// Main-process test driver. Browser code runs in the ordinary isolated page;
// it never imports Node modules or receives a test-only privileged bridge.
const assert = require('assert');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait(check, label, timeout = 10000) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + label);
    await sleep(25);
  }
}

function browserDriver(window) {
  const inspect = (fn, ...args) => window.webContents.executeJavaScript(
    `(${fn.toString()})(...${JSON.stringify(args)})`);
  const exists = selector => inspect(selector => Boolean(document.querySelector(selector)), selector);
  const click = (selector, options = {}) => inspect((selector, options) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error('Missing UI control: ' + selector);
    target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, detail:1, ...options}));
    return true;
  }, selector, options);
  const type = (selector, value) => inspect((selector, value) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error('Missing UI control: ' + selector);
    const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, value);
    target.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  }, selector, value);
  const row = id => `tr[vid_id="${id}"]`;
  const selected = () => inspect(() => [...document.querySelectorAll('tr.movie-row.selected')]
    .map(element => element.getAttribute('vid_id')));
  async function selectOnly(id) {
    await wait(() => exists(row(id)), 'fixture row');
    const selection = await selected();
    if (selection.length !== 1 || selection[0] !== id) await click(row(id));
    await wait(async () => { const selection = await selected();
      return selection.length === 1 && selection[0] === id; }, 'single selection');
  }
  async function edit(id) {
    await selectOnly(id); await click('#edit-button');
    await wait(() => exists('#edit-container .edit-field-title'), 'editor');
  }
  async function save(check) {
    await click('#edit-container .save-btn');
    await wait(check, 'confirmed editor save');
    await wait(() => inspect(() => document.querySelector('#edit-container .save-btn').value === 'Save'),
      'editor acknowledgment');
  }
  async function closeEditor() {
    await click('#editor-pane .openable-close-btn');
    await wait(async () => !await exists('#edit-container'), 'closed editor');
  }
  async function settings() {
    await click('#settings-button');
    await wait(() => exists('#settings-tab-preferences'), 'settings tabs');
    await click('#settings-tab-preferences');
    await wait(() => inspect(() => document.querySelectorAll('#settings-prefs-libraryexclusions input').length === 2),
      'preference controls');
  }
  async function start() {
    await inspect(() => { window.alert = message => { throw new Error('Unexpected app alert: ' + message); }; return true; });
    await wait(() => exists('#grid-container'), 'initial UI');
    const capabilities = await inspect(() => ({require:typeof require, process:typeof process, Buffer:typeof Buffer,
      bridge:typeof window.mynda}));
    assert.deepStrictEqual(capabilities, {require:'undefined', process:'undefined', Buffer:'undefined', bridge:'object'});
  }
  return {inspect, exists, click, type, row, selected, selectOnly, edit, save, closeEditor, settings, start};
}

module.exports = {browserDriver, wait};
