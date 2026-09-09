#!/usr/bin/env node
const MediaTools = require('../src/MediaTools.js');

const status = MediaTools.status();
const target = `${MediaTools.builderPlatform(process.platform)}-${process.arch}`;
console.log(`Mynda media tools for ${target}:`);
for (const name of ['ffmpeg', 'ffprobe', 'mpv']) {
  const tool = status[name];
  console.log(
    `  ${name.padEnd(7)} ${tool.available ? tool.source : 'missing'}` +
    `${tool.path ? ` — ${tool.path}` : ''}`
  );
}

if (Object.values(status).some(tool => tool.source !== 'staged' && tool.source !== 'packaged')) {
  console.log('\nDevelopment may use overrides or system tools, but packaging requires a verified staged bundle.');
  console.log('Run "npm run media:prepare" on this target before test:media, test:package, or dist.');
}
