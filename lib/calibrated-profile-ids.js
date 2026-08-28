// The calibrated profile identifiers, in a form both the main process and the
// renderer can load. The renderer has no `require`, and the rest of
// calibrated-profiles.js pulls in Node-side validation it cannot use, so only
// the names and the framing they map to live here.
//
// One definition rather than two: a renderer copy of these strings that drifts
// from the main process's copy fails as "unsupported profile" at launch, which
// is the same class of bug that had four different opinions about Low
// Latency's output size.
(function attachCalibratedProfileIds(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CalibratedProfileIds = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const WIDESCREEN_LEFT = 'calibratedWidescreenLeft';
  const WIDESCREEN_RIGHT = 'calibratedWidescreenRight';
  const SQUARE_LEFT = 'calibratedSquareLeft';
  const SQUARE_RIGHT = 'calibratedSquareRight';

  const CALIBRATED_PROFILE_IDS = Object.freeze([
    WIDESCREEN_LEFT,
    WIDESCREEN_RIGHT,
    SQUARE_LEFT,
    SQUARE_RIGHT,
  ]);
  const CALIBRATED_PROFILE_SET = new Set(CALIBRATED_PROFILE_IDS);

  function isCalibratedProfileId(profileId) {
    return CALIBRATED_PROFILE_SET.has(profileId);
  }

  // The user picks framing -- 16:9 or 1:1, and which eye -- and that selection
  // names the profile. 16:9 defaults to the right eye to match the locked
  // profiles, three of which crop the right eye.
  function getCalibratedProfileId(outputFormat, rightEye) {
    if (outputFormat === 'square') {
      return rightEye === true ? SQUARE_RIGHT : SQUARE_LEFT;
    }
    return rightEye === true ? WIDESCREEN_RIGHT : WIDESCREEN_LEFT;
  }

  return Object.freeze({
    CALIBRATED_PROFILE_IDS,
    SQUARE_LEFT,
    SQUARE_RIGHT,
    WIDESCREEN_LEFT,
    WIDESCREEN_RIGHT,
    getCalibratedProfileId,
    isCalibratedProfileId,
  });
}));
