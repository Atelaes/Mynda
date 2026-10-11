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
  async function execute(label, fn, args) {
    // Electron otherwise replaces renderer exceptions with "Script failed to
    // execute". Return plain error details across the existing test boundary.
    const result = await window.webContents.executeJavaScript(`(async () => {
      try { return {ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})}; }
      catch (error) { return {ok:false,error:{name:String(error && error.name || 'Error'),
        message:String(error && error.message || error),stack:String(error && error.stack || '')}}; }
    })()`).catch(error => {
      throw new Error(`Renderer action failed (${label}): ${error.message || error}`);
    });
    if (!result.ok) {
      const error = new Error(`Renderer action failed (${label}): ${result.error.name}: ${result.error.message}`);
      if (result.error.stack) error.stack += '\nRenderer stack:\n' + result.error.stack;
      throw error;
    }
    return result.value;
  }
  const inspect = (fn, ...args) => execute('inspect ' + fn.toString().slice(0,180),fn,args);
  const exists = selector => inspect(selector => Boolean(document.querySelector(selector)), selector);
  const click = (selector, options = {}) => execute('click ' + selector,(selector, options) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error('Missing UI control: ' + selector);
    target.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, detail:1, ...options}));
    return true;
  }, [selector, options]);
  const type = (selector, value) => execute('type ' + selector,(selector, value) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error('Missing UI control: ' + selector);
    const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, value);
    target.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  }, [selector, value]);
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
