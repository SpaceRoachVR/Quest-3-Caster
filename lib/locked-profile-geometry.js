// The one place in the JavaScript layer that describes what each locked
// profile actually delivers. These values mirror `profiles[]` in
// `app/src/q3c/profile.c`, created by native/patches/0002 and extended by
// 0003. The native runtime is authoritative -- it reports its real delivered
// size in the ready event -- and everything here exists so the desktop layer
// can validate that report and describe it to the user without four
// independent copies of the numbers drifting apart.
//
// They did drift: Low Latency moved to a 1792x1008 crop so its rotated sample
// stays inside one eye, and the preflight records, the settings help text, and
// the attempt-state validator all kept claiming 1920x1080.
//
// Loaded both by Node (main process, tests) and by the renderer through a
// plain script tag, so it carries no dependencies.
(function attachLockedProfileGeometry(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LockedProfileGeometry = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  function frozenSize(width, height) {
    return Object.freeze({ width, height });
  }

  // `window` matches `output` for every profile. SDL scales the decoded frame
  // to the window and OBS captures the window, so a mismatch resamples the
  // image after the pipeline went to some trouble to avoid resampling.
  const LOCKED_PROFILE_GEOMETRY = Object.freeze({
    obsLowLatency1080p60: Object.freeze({
      serverCrop: '1792:1008:2200:600',
      presentationAngle: '-22',
      output: frozenSize(1792, 1008),
      window: frozenSize(1792, 1008),
      stabilization: 'off',
      nominalDelayMs: 0,
      maximumDelayMs: 0,
    }),
    obsStabilized1080p60: Object.freeze({
      serverCrop: '2064:1160:2064:524',
      presentationAngle: '-22',
      output: frozenSize(1920, 1080),
      window: frozenSize(1920, 1080),
      stabilization: 'openclFeaturePoint',
      nominalDelayMs: 100,
      maximumDelayMs: 120,
    }),
    obsLowLatencySquareLeft1080p60: Object.freeze({
      serverCrop: '1488:1488:288:360',
      presentationAngle: '20',
      output: frozenSize(1080, 1080),
      window: frozenSize(1080, 1080),
      stabilization: 'off',
      nominalDelayMs: 0,
      maximumDelayMs: 0,
    }),
    obsLowLatencySquareRight1080p60: Object.freeze({
      serverCrop: '1488:1488:2352:360',
      presentationAngle: '-22',
      output: frozenSize(1080, 1080),
      window: frozenSize(1080, 1080),
      stabilization: 'off',
      nominalDelayMs: 0,
      maximumDelayMs: 0,
    }),
  });

  const PROFILE_IDS = Object.freeze(Object.keys(LOCKED_PROFILE_GEOMETRY));

  function hasProfileGeometry(profileId) {
    return Object.hasOwn(LOCKED_PROFILE_GEOMETRY, profileId);
  }

  function getProfileGeometry(profileId) {
    if (!hasProfileGeometry(profileId)) {
      throw new Error(`No locked geometry is defined for profile ${profileId}.`);
    }
    return LOCKED_PROFILE_GEOMETRY[profileId];
  }

  function getProfileOutput(profileId) {
    return getProfileGeometry(profileId).output;
  }

  function formatProfileOutput(profileId) {
    const output = getProfileOutput(profileId);
    return `${output.width}x${output.height}`;
  }

  return Object.freeze({
    LOCKED_PROFILE_GEOMETRY,
    PROFILE_IDS,
    formatProfileOutput,
    getProfileGeometry,
    getProfileOutput,
    hasProfileGeometry,
  });
}));
