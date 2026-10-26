#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {builtinModules} = require('module');
const esbuild = require('esbuild');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = 'src/renderer/generated/renderer.js';
const PRELOAD_PATH = 'src/preload/generated/preload.js';
const forbiddenImports = new Set(['electron', ...builtinModules.map(name => name.replace(/^node:/, ''))]);

// A new privileged import must fail the build. In particular, do not silently
// replace filesystem/process modules with browser shims or external requires.
const browserBoundary = {
  name: 'mynda-renderer-boundary',
  setup(build) {
    build.onResolve({filter: /^[^./]|^node:/}, args => {
      const request = args.path.replace(/^node:/, '');
      if (forbiddenImports.has(request)) {
        return {errors: [{text: `The isolated renderer cannot import ${args.path}; use the preload API instead.`}]};
      }
    });
  }
};

async function buildRenderer(options = {}) {
  const root = options.root || PROJECT_ROOT;
  const mode = options.mode || 'development';
  if (!['development', 'production'].includes(mode)) throw new Error(`Unknown renderer build mode: ${mode}`);
  const outfile = options.outfile || path.join(root, OUTPUT_PATH);
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [options.entryPoint || 'src/renderer/Renderer.js'],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    // Electron 44 ships Chromium 152. Upgrade this only with the Electron pin.
    target: 'chrome152',
    loader: {'.js': 'jsx'},
    define: {'process.env.NODE_ENV': JSON.stringify(mode)},
    minify: mode === 'production',
    // Keep release maps for developer debugging without shipping them or
    // pointing the packaged browser at a map that is deliberately excluded.
    sourcemap: mode === 'production' ? 'external' : 'linked',
    sourcesContent: mode !== 'production',
    legalComments: 'eof',
    metafile: true,
    write: false,
    logLevel: options.logLevel || 'silent',
    plugins: [browserBoundary]
  });
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.length) throw new Error('Renderer build retained a runtime import; all dependencies must be bundled.');
  }
  // Build from current bytes every time, including source overlays preserving
  // old mtimes. Only replace the previous bundle after compilation succeeds.
  for (const output of result.outputFiles) {
    fs.mkdirSync(path.dirname(output.path), {recursive: true});
    fs.writeFileSync(output.path, output.contents);
  }
  const preload = options.entryPoint ? null : await buildPreload({root});
  return {outfile, metafile: result.metafile, mode, preload};
}

async function buildPreload({root = PROJECT_ROOT} = {}) {
  const outfile = path.join(root, PRELOAD_PATH);
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/preload/index.js'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
    write: false,
    logLevel: 'silent',
    plugins: [{name: 'mynda-sandbox-preload', setup(build) {
      build.onResolve({filter: /^[^./]|^node:/}, args => {
        if (args.path !== 'electron' && forbiddenImports.has(args.path.replace(/^node:/, ''))) {
          return {errors: [{text: `Sandboxed preload cannot import ${args.path}.`}]};
        }
      });
    }}]
  });
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some(entry => entry.path !== 'electron')) {
      throw new Error('Sandboxed preload retained a dependency other than Electron.');
    }
  }
  for (const output of result.outputFiles) {
    fs.mkdirSync(path.dirname(output.path), {recursive: true});
    fs.writeFileSync(output.path, output.contents);
  }
  return {outfile, metafile: result.metafile};
}

if (require.main === module) {
  buildRenderer({mode: process.argv.includes('--production') ? 'production' : 'development'})
    .then(result => console.log(`Built ${path.relative(PROJECT_ROOT, result.outfile)} (${result.mode}, Chromium 152).`))
    .catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = {buildRenderer, buildPreload, browserBoundary, OUTPUT_PATH, PRELOAD_PATH};
