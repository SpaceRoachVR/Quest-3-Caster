'use strict';

// Which headsets this app knows how to frame, and how much of that knowledge
// was actually measured on hardware rather than assumed.
//
// Preflight used to compare the display against one hardcoded 4128x2208 and
// refuse everything else, so a Quest 3S owner got a geometry-mismatch string
// naming a resolution their headset does not have. Two things were conflated
// there: whether a configuration is structurally valid, and whether this
// particular headset has been calibrated. They fail for different reasons and
// deserve different answers.
//
// Nothing here is a promise that a device streams correctly. It records what
// is known, how it came to be known, and -- for anything uncalibrated -- what
// a conservative fallback would look like. `calibration` is the honest part:
//
//   measured     crops and angles came off real hardware, via the flood-fill
//                and angle sweep in docs; safe to default to.
//   provisional  derived from a measured sibling or from a calibration run
//                that has not been physically confirmed; offered, labelled,
//                never the default.
//   uncalibrated nothing measured. Framing is derived from geometry alone and
//                is not claimed to be correct.
//
// Quest 2 and Quest 3S share a panel resolution, so geometry alone cannot tell
// them apart. Model is therefore the primary key and geometry the fallback.

const CALIBRATION_TIERS = Object.freeze(['measured', 'provisional', 'uncalibrated']);

// Per-eye physical panel resolutions, from Meta's render-scale documentation
// (developers.meta.com, "Screen resolutions and render scales per headset").
// The display buffer is the two eyes side by side, which is confirmed on
// Quest 3 -- 2064x2208 per eye reports as 4128x2208 -- and expected but not
// confirmed elsewhere, which is what `displayConfirmed` records.
const DEVICE_PROFILES = Object.freeze([
  Object.freeze({
    id: 'quest3',
    name: 'Meta Quest 3',
    models: Object.freeze(['Quest 3']),
    eye: Object.freeze({ width: 2064, height: 2208 }),
    display: Object.freeze({ width: 4128, height: 2208 }),
    displayConfirmed: true,
    calibration: 'measured',
    // Crops and angles live in the native profile table (profile.c). Listing
    // them here would be a fifth copy of numbers that already drifted once.
    nativeProfiles: true,
    lensMaskFraction: 0.166,
    notes: 'Crops flood-filled from a captured frame; angles swept against the '
      + 'roll-locked Quest menu.',
  }),
  Object.freeze({
    id: 'quest3s',
    name: 'Meta Quest 3S',
    models: Object.freeze(['Quest 3S']),
    eye: Object.freeze({ width: 1832, height: 1920 }),
    display: Object.freeze({ width: 3664, height: 1920 }),
    // Confirmed against hardware: `wm size` reports 3664x1920 and a captured
    // frame is the composited stereo buffer, two eyes side by side.
    displayConfirmed: true,
    calibration: 'uncalibrated',
    nativeProfiles: false,
    lensMaskFraction: 0.1645,
    notes: 'Fresnel optics rather than Quest 3 pancakes, so the lens mask and '
      + 'panel cant are its own. Measured mask is 16.45% of the display, close '
      + "to Quest 3's 16.6%. Aperture edges sit within ~1 degree of vertical on "
      + 'both eyes rather than tilting in opposite directions as Quest 3 does, '
      + 'so its panels appear not to be canted. Run the calibration wizard.',
  }),
  Object.freeze({
    id: 'quest2',
    name: 'Meta Quest 2',
    models: Object.freeze(['Quest 2']),
    eye: Object.freeze({ width: 1832, height: 1920 }),
    display: Object.freeze({ width: 3664, height: 1920 }),
    displayConfirmed: false,
    calibration: 'uncalibrated',
    nativeProfiles: false,
    lensMaskFraction: null,
    notes: 'Shares the Quest 3S panel resolution, so geometry alone cannot '
      + 'tell the two apart; identified by model.',
  }),
  Object.freeze({
    id: 'questPro',
    name: 'Meta Quest Pro',
    models: Object.freeze(['Quest Pro']),
    eye: Object.freeze({ width: 1800, height: 1920 }),
    display: Object.freeze({ width: 3600, height: 1920 }),
    displayConfirmed: false,
    calibration: 'uncalibrated',
    nativeProfiles: false,
    lensMaskFraction: null,
    notes: 'Not currently on the roadmap; listed so it is identified by name '
      + 'rather than reported as an unknown display.',
  }),
]);

function normalizeModel(model) {
  return typeof model === 'string' ? model.trim() : '';
}

function isValidGeometry(geometry) {
  return Boolean(geometry)
    && Number.isSafeInteger(geometry.width) && geometry.width > 0
    && Number.isSafeInteger(geometry.height) && geometry.height > 0;
}

function sameGeometry(a, b) {
  return Boolean(a) && Boolean(b) && a.width === b.width && a.height === b.height;
}

function findByModel(model) {
  const normalized = normalizeModel(model).toLowerCase();
  if (!normalized) {
    return null;
  }
  return DEVICE_PROFILES.find((device) => device.models.some(
    (candidate) => candidate.toLowerCase() === normalized,
  )) || null;
}

// Geometry is only conclusive when exactly one device claims it. Quest 2 and
// Quest 3S both report 3664x1920, so an ambiguous match identifies nothing and
// must say so rather than picking the first row.
function findByDisplay(displaySize) {
  if (!isValidGeometry(displaySize)) {
    return { device: null, ambiguous: false, candidates: [] };
  }
  const candidates = DEVICE_PROFILES.filter(
    (device) => sameGeometry(device.display, displaySize),
  );
  return {
    device: candidates.length === 1 ? candidates[0] : null,
    ambiguous: candidates.length > 1,
    candidates,
  };
}

function unknownDevice(displaySize) {
  return Object.freeze({
    id: 'unknown',
    name: 'Unrecognized headset',
    models: Object.freeze([]),
    eye: Object.freeze({
      // The display buffer is the two eyes side by side on every Quest whose
      // geometry has been confirmed. Assumed, not known, for a device the
      // registry has never seen.
      width: Math.floor(displaySize.width / 2),
      height: displaySize.height,
    }),
    display: Object.freeze({ ...displaySize }),
    displayConfirmed: false,
    calibration: 'uncalibrated',
    nativeProfiles: false,
    lensMaskFraction: null,
    notes: 'No registry entry matches this headset by model or display size.',
  });
}

// `model` comes from `ro.product.model` and is preferred, because two devices
// share a display size. Geometry decides only when the model is unknown, and
// a model match whose geometry disagrees is reported rather than trusted --
// that is what a display-size override on a known headset looks like.
function identifyDevice({ model, displaySize } = {}) {
  if (!isValidGeometry(displaySize)) {
    throw new Error('A valid display geometry is required to identify a headset.');
  }
  const detected = Object.freeze({ width: displaySize.width, height: displaySize.height });
  const byModel = findByModel(model);
  if (byModel) {
    const geometryMatches = sameGeometry(byModel.display, detected);
    return Object.freeze({
      device: byModel,
      detected,
      matchedBy: 'model',
      geometryMatches,
      ambiguous: false,
      reason: geometryMatches ? null
        : `${byModel.name} normally reports ${byModel.display.width}x${byModel.display.height}`
          + `, but this headset reports ${detected.width}x${detected.height}.`,
    });
  }

  const { device, ambiguous, candidates } = findByDisplay(detected);
  if (device) {
    return Object.freeze({
      device,
      detected,
      matchedBy: 'display',
      geometryMatches: true,
      ambiguous: false,
      reason: null,
    });
  }
  if (ambiguous) {
    const names = candidates.map((candidate) => candidate.name).join(' or ');
    return Object.freeze({
      device: unknownDevice(detected),
      detected,
      matchedBy: 'none',
      geometryMatches: false,
      ambiguous: true,
      reason: `${detected.width}x${detected.height} matches ${names}. `
        + 'The headset model is needed to tell them apart.',
    });
  }
  return Object.freeze({
    device: unknownDevice(detected),
    detected,
    matchedBy: 'none',
    geometryMatches: false,
    ambiguous: false,
    reason: `No headset in the registry reports ${detected.width}x${detected.height}.`,
  });
}

// The locked native profiles carry Quest 3 crops baked into profile.c, so they
// are correct only on a device whose calibration is measured AND whose crops
// that table actually holds. Everything else needs its own measurement before
// the framing means anything.
function getLockedProfileSupport(identification) {
  const { device } = identification;
  if (device.calibration === 'measured' && device.nativeProfiles === true) {
    if (!identification.geometryMatches) {
      return Object.freeze({
        supported: false,
        tier: device.calibration,
        reason: identification.reason
          || 'The headset is not reporting its calibrated display geometry.',
      });
    }
    return Object.freeze({ supported: true, tier: 'measured', reason: null });
  }
  if (device.id === 'unknown') {
    return Object.freeze({
      supported: false,
      tier: 'uncalibrated',
      reason: `${identification.reason} The calibrated profiles are measured `
        + 'against a specific panel and lens mask, so they would mis-frame this '
        + 'headset. Run the calibration wizard to measure it.',
    });
  }
  return Object.freeze({
    supported: false,
    tier: device.calibration,
    reason: `${device.name} is recognized but not calibrated yet. `
      + 'The calibrated profiles carry Quest 3 crops and would mis-frame it. '
      + 'Run the calibration wizard to measure this headset.',
  });
}

function listDevices() {
  return DEVICE_PROFILES;
}

module.exports = {
  CALIBRATION_TIERS,
  DEVICE_PROFILES,
  findByDisplay,
  findByModel,
  getLockedProfileSupport,
  identifyDevice,
  listDevices,
};
