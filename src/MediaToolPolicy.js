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
  if (!has('--disable-version3')) problems.push('missing --disable-version3');
  if (has('--enable-gpl')) problems.push('contains --enable-gpl');
  if (has('--enable-nonfree')) problems.push('contains --enable-nonfree');
  if (has('--enable-version3')) problems.push('contains --enable-version3');

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

const MPV_VIDEO_REQUIREMENTS = {
  darwin: {
    label: 'macOS',
    videoOutputs: ['gpu-next'],
    requiredContextGroups: [['macvk']],
    runtimeContexts: ['macvk'],
    description: 'gpu-next with the macvk Vulkan window context'
  },
  win32: {
    label: 'Windows',
    videoOutputs: ['gpu-next'],
    requiredContextGroups: [['d3d11']],
    runtimeContexts: ['d3d11'],
    description: 'gpu-next with the native Direct3D 11 window context'
  },
  linux: {
    label: 'Linux',
    videoOutputs: ['gpu-next'],
    // The release bundle must work in both common Linux desktop sessions.
    // Vulkan is preferred, while EGL remains an accepted fallback.
    requiredContextGroups: [
      ['waylandvk', 'wayland'],
      ['x11vk', 'x11egl', 'x11']
    ],
    runtimeContexts: ['waylandvk', 'wayland', 'x11vk', 'x11egl', 'x11'],
    description: 'gpu-next with both Wayland and X11 window contexts'
  }
};

function mpvVideoRequirements(platform) {
  const requirements = MPV_VIDEO_REQUIREMENTS[platform];
  if (!requirements) {
    const error = new Error(`No bundled MPV video policy exists for platform: ${platform}`);
    error.code = 'MYNDA_MEDIA_PLATFORM_UNSUPPORTED';
    throw error;
  }
  return requirements;
}

function inspectMpvVideoSupport(platform, videoOutputHelp, gpuContextHelp) {
  const requirements = mpvVideoRequirements(platform);
  const videoOutputs = requirements.videoOutputs.filter(choice =>
    outputHasChoice(videoOutputHelp, choice)
  );
  const availableContexts = requirements.runtimeContexts.filter(choice =>
    outputHasChoice(gpuContextHelp, choice)
  );
  const problems = [];

  if (!videoOutputs.includes('gpu-next')) {
    problems.push('missing gpu-next video output');
  }
  for (const alternatives of requirements.requiredContextGroups) {
    if (!alternatives.some(choice => availableContexts.includes(choice))) {
      problems.push(`missing ${alternatives.join(' or ')} window context`);
    }
  }

  return {
    platform,
    graphical: problems.length === 0,
    videoOutputs,
    gpuContexts: availableContexts,
    runtimeContexts: requirements.runtimeContexts.slice(),
    description: requirements.description,
    problems
  };
}

function assertMpvVideoSupport(platform, videoOutputHelp, gpuContextHelp) {
  const inspection = inspectMpvVideoSupport(platform, videoOutputHelp, gpuContextHelp);
  if (!inspection.graphical) {
    const requirements = mpvVideoRequirements(platform);
    const error = new Error(
      `Bundled MPV cannot create Mynda's ${requirements.label} video window: ` +
      inspection.problems.join(', ')
    );
    error.code = 'MYNDA_MPV_VIDEO_OUTPUT_UNAVAILABLE';
    error.inspection = inspection;
    throw error;
  }
  return inspection;
}

// A macOS MPV executable can still decode audio when it was compiled without
// a graphical window backend. Mynda's current MPV 0.41 bundle deliberately
// uses gpu-next through Vulkan's macvk context, so all three pieces must be
// present before the stage is considered releasable.
function inspectMpvMacVideoSupport(videoOutputHelp, gpuContextHelp) {
  return inspectMpvVideoSupport('darwin', videoOutputHelp, gpuContextHelp);
}

function assertMpvMacVideoSupport(videoOutputHelp, gpuContextHelp) {
  return assertMpvVideoSupport('darwin', videoOutputHelp, gpuContextHelp);
}

module.exports = {
  assertLgplOnlyFfmpeg,
  assertMpvDvdSupport,
  assertMpvMacVideoSupport,
  assertMpvVideoSupport,
  configurationFlags,
  configurationLine,
  firstLine,
  inspectFfmpegLicense,
  inspectMpvMacVideoSupport,
  inspectMpvVideoSupport,
  mpvVideoRequirements,
  mpvSupportsDvd
};
