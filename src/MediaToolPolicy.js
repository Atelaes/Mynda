function firstLine(value) {
  return String(value || '').split(/\r?\n/).find(line => line.trim()) || '';
}

function configurationLine(versionOutput) {
  return String(versionOutput || '').split(/\r?\n/)
    .find(line => /^configuration:\s*/i.test(line.trim())) || '';
}

function configurationFlags(versionOutput) {
  const line = configurationLine(versionOutput);
  return line.replace(/^\s*configuration:\s*/i, '').trim().split(/\s+/).filter(Boolean);
}

function inspectFfmpegLicense(versionOutput) {
  const flags = configurationFlags(versionOutput);
  const has = flag => flags.includes(flag);
  const problems = [];

  if (!has('--disable-gpl')) problems.push('missing --disable-gpl');
  if (!has('--disable-nonfree')) problems.push('missing --disable-nonfree');
  if (has('--enable-gpl')) problems.push('contains --enable-gpl');
  if (has('--enable-nonfree')) problems.push('contains --enable-nonfree');

  return {
    configuration: configurationLine(versionOutput),
    flags,
    lgplOnly: problems.length === 0,
    problems
  };
}

function assertLgplOnlyFfmpeg(versionOutput, label = 'FFmpeg') {
  const inspection = inspectFfmpegLicense(versionOutput);
  if (!inspection.lgplOnly) {
    const error = new Error(
      `${label} is not the approved LGPL-only build: ${inspection.problems.join(', ') || 'unknown configuration'}`
    );
    error.code = 'MYNDA_MEDIA_LICENSE_POLICY';
    error.inspection = inspection;
    throw error;
  }
  return inspection;
}

function mpvSupportsDvd(protocolOutput) {
  return /(?:^|\s)dvd(?:nav)?:\/\/(?:\s|$)/im.test(String(protocolOutput || ''));
}

function assertMpvDvdSupport(protocolOutput) {
  if (!mpvSupportsDvd(protocolOutput)) {
    const error = new Error('Bundled MPV does not report dvd:// or dvdnav:// support');
    error.code = 'MYNDA_MPV_DVD_UNAVAILABLE';
    throw error;
  }
  return true;
}

function outputHasChoice(output, choice) {
  const escaped = String(choice).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'im')
    .test(String(output || ''));
}

// A macOS MPV executable can still decode audio when it was compiled without
// a graphical window backend. Mynda's current MPV 0.41 bundle deliberately
// uses gpu-next through Vulkan's macvk context, so all three pieces must be
// present before the stage is considered releasable.
function inspectMpvMacVideoSupport(videoOutputHelp, gpuContextHelp) {
  const videoOutputs = ['gpu-next', 'gpu'].filter(choice =>
    outputHasChoice(videoOutputHelp, choice)
  );
  const gpuContexts = ['macvk'].filter(choice =>
    outputHasChoice(gpuContextHelp, choice)
  );
  const problems = [];

  if (!videoOutputs.includes('gpu-next')) {
    problems.push('missing gpu-next video output');
  }
  if (!gpuContexts.includes('macvk')) {
    problems.push('missing macvk Vulkan window context');
  }

  return {
    graphical: problems.length === 0,
    videoOutputs,
    gpuContexts,
    problems
  };
}

function assertMpvMacVideoSupport(videoOutputHelp, gpuContextHelp) {
  const inspection = inspectMpvMacVideoSupport(videoOutputHelp, gpuContextHelp);
  if (!inspection.graphical) {
    const error = new Error(
      `Bundled MPV cannot create Mynda's macOS video window: ${inspection.problems.join(', ')}`
    );
    error.code = 'MYNDA_MPV_VIDEO_OUTPUT_UNAVAILABLE';
    error.inspection = inspection;
    throw error;
  }
  return inspection;
}

module.exports = {
  assertLgplOnlyFfmpeg,
  assertMpvDvdSupport,
  assertMpvMacVideoSupport,
  configurationFlags,
  configurationLine,
  firstLine,
  inspectFfmpegLicense,
  inspectMpvMacVideoSupport,
  mpvSupportsDvd
};
