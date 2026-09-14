const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

function filesUnder(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function assertExactPath(filename, base) {
  // Check every spelling even on Windows/macOS, where existsSync alone can
  // accept imports that will fail on a case-sensitive Linux filesystem.
  const absolute = path.resolve(filename);
  let current = base ? path.resolve(base) : path.dirname(absolute);
  if (path.relative(current, absolute).startsWith('..')) throw new Error(`Path escapes project: ${absolute}`);
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    if (!fs.readdirSync(current).includes(component)) {
      throw new Error(`Missing file or incorrect capitalization: ${absolute}`);
    }
    current = path.join(current, component);
  }
  return absolute;
}

function visit(node, operation) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(value => visit(value, operation));
  if (node.type) operation(node);
  for (const key of Object.keys(node)) {
    if (!['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(key)) {
      visit(node[key], operation);
    }
  }
}

function auditReferences(root) {
  const errors = [];
  const references = [];
  const mainCss = path.join(root, 'src', 'renderer', 'styles', 'main.css');
  const renderer = path.join(root, 'src', 'renderer', 'index.html');
  function check(owner, reference, target, kind) {
    try {
      assertExactPath(target, root);
      references.push({owner: path.relative(root, owner), reference, target: path.relative(root, target), kind});
    } catch (error) {
      errors.push(`${path.relative(root, owner)}: ${reference} — ${error.message}`);
    }
  }
  function checkUrl(owner, reference, base = owner) {
    if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
    const clean = decodeURIComponent(reference.split(/[?#]/)[0]);
    check(owner, reference, path.resolve(path.dirname(base), clean), 'resource');
  }
  function inspectJavaScript(owner, source, effectiveOwner = owner) {
    let ast;
    try {
      ast = babel.parseSync(source, {babelrc: false, configFile: false, parserOpts: {plugins: ['jsx']}});
    } catch (error) {
      errors.push(`${path.relative(root, owner)}: JavaScript/JSX syntax error: ${error.message}`);
      return;
    }
    visit(ast, node => {
      const callee = node.callee;
      const isRequire = callee && (callee.type === 'Identifier' && callee.name === 'require' ||
        callee.type === 'MemberExpression' && callee.object.name === 'require' && callee.property.name === 'resolve');
      if (node.type === 'CallExpression' && isRequire && node.arguments[0] && node.arguments[0].type === 'StringLiteral') {
        const reference = node.arguments[0].value;
        if (!reference.startsWith('.')) return;
        try {
          const target = Module.createRequire(effectiveOwner).resolve(reference);
          check(owner, reference, target, 'module');
        } catch (error) {
          const requested = path.resolve(path.dirname(effectiveOwner), reference);
          // omdb.js is deliberately supplied by each developer and is ignored
          // by Git. A clean checkout may omit it; its two imports must still
          // point to the project root. The archive/Electron tests supply a fake
          // key there, so these checks never need anyone's real credentials.
          if (requested === path.join(root, 'omdb') || requested === path.join(root, 'omdb.js')) {
            references.push({owner: path.relative(root, owner), reference, target: 'omdb.js', kind: 'module'});
          } else {
            errors.push(`${path.relative(root, owner)}: cannot resolve ${reference}`);
          }
        }
      }
      const value = node.type === 'StringLiteral' ? node.value :
        node.type === 'TemplateElement' ? node.value.cooked : '';
      if (value && (/^(?:\.\.\/)+images\//.test(value) || /^styles\/themes\//.test(value))) {
        checkUrl(owner, value, renderer);
      }
    });
  }
  for (const folder of ['src', 'scripts', 'test']) {
    for (const owner of filesUnder(path.join(root, folder))) {
      if (!/\.(?:js|html|css)$/.test(owner)) continue;
      const source = fs.readFileSync(owner, 'utf8');
      if (owner.endsWith('.js')) {
        // The E2E bootstrap is copied to the disposable app root before use.
        const effective = owner === path.join(root, 'test', 'electron', 'SmokeBootstrap.js') ?
          path.join(root, 'SmokeBootstrap.js') : owner;
        inspectJavaScript(owner, source, effective);
      } else if (owner.endsWith('.html')) {
        const html = source.replace(/<!--[\s\S]*?-->/g, '');
        for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(['"])(.*?)\1/g)) checkUrl(owner, match[2]);
        for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          inspectJavaScript(owner, match[1]);
        }
      } else {
        const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const match of css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/g)) {
          const declaration = css.slice(0, match.index).split(/[;{}]/).pop();
          const customProperty = /^\s*--[\w-]+\s*:/.test(declaration);
          checkUrl(owner, match[2].trim(), customProperty ? mainCss : owner);
        }
        for (const match of css.matchAll(/@import\s+(['"])(.*?)\1/g)) checkUrl(owner, match[2]);
      }
    }
  }
  return {errors, references};
}

module.exports = {filesUnder, assertExactPath, auditReferences};
