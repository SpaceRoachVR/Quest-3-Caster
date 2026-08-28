(function attachRendererQuality(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.RendererQuality = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (root) => {
  'use strict';

  // Node (tests, and anything in the main process) resolves this through
  // require; the renderer gets it from the script tag in index.html that runs
  // before this file.
  const { getProfileGeometry, getProfileOutput } =
    typeof require === 'function'
      ? require('./locked-profile-geometry')
      : root.LockedProfileGeometry;
  const { getCalibratedProfileId, isCalibratedProfileId } =
    typeof require === 'function'
      ? require('./calibrated-profile-ids')
      : root.CalibratedProfileIds;

  function formatOutput(profileId) {
    const output = getProfileOutput(profileId);
    return `${output.width}x${output.height}`;
  }

  const LOW_LATENCY_PROFILE_ID = 'obsLowLatency1080p60';
  const STABILIZED_PROFILE_ID = 'obsStabilized1080p60';
  const SQUARE_LEFT_PROFILE_ID = 'obsLowLatencySquareLeft1080p60';
  const SQUARE_RIGHT_PROFILE_ID = 'obsLowLatencySquareRight1080p60';
  const WIDESCREEN_OUTPUT = 'widescreen';
  const SQUARE_OUTPUT = 'square';
  const PROFILE_MIGRATION_VERSION = '3';
  const LOCKED_PROFILE_IDS = Object.freeze([
    LOW_LATENCY_PROFILE_ID,
    STABILIZED_PROFILE_ID,
    SQUARE_LEFT_PROFILE_ID,
    SQUARE_RIGHT_PROFILE_ID
  ]);
  const VISIBLE_PROFILE_IDS = new Set(LOCKED_PROFILE_IDS);
  const PROFILE_NAMES = Object.freeze({
    [LOW_LATENCY_PROFILE_ID]: 'OBS Low Latency — 1080p60',
    [STABILIZED_PROFILE_ID]: 'OBS Stabilized — 1080p60'
  });
  const PROFILE_DESCRIPTIONS = Object.freeze({
    [LOW_LATENCY_PROFILE_ID]:
      `Fastest response: H.264 40 Mbps/60 FPS, calibrated ${formatOutput(LOW_LATENCY_PROFILE_ID)} output, and zero video buffer.`,
    [STABILIZED_PROFILE_ID]:
      'Opt-in: smooths small natural head shake with OpenCL, adds approximately 100 ms, increases GPU load, and uses slightly wider calibrated right-eye framing. Physical Quest + OBS verification pending.'
  });

  // The crop and delivered size in this help text are the numbers the native
  // runtime actually uses, injected from the shared geometry. Written out by
  // hand they went stale -- Low Latency described a 1920:1080:2136:564 crop and
  // a 1920x1080 output long after profile.c moved to 1792:1008:2200:600.
  const SETTINGS_HELP_FRAMING = Object.freeze({
    [LOW_LATENCY_PROFILE_ID]: 'eye-centred right-eye crop',
    [STABILIZED_PROFILE_ID]: 'right-eye overscan',
    [SQUARE_LEFT_PROFILE_ID]: 'mask-free left-eye crop',
    [SQUARE_RIGHT_PROFILE_ID]: 'mask-free right-eye crop'
  });
  const SETTINGS_HELP_DELIVERY = Object.freeze({
    [LOW_LATENCY_PROFILE_ID]: 'native OUTPUT output with no resampling',
    [STABILIZED_PROFILE_ID]: 'centered OUTPUT output',
    [SQUARE_LEFT_PROFILE_ID]: 'downscaled to OUTPUT output',
    [SQUARE_RIGHT_PROFILE_ID]: 'downscaled to OUTPUT output'
  });
  const SETTINGS_HELP_TAIL = Object.freeze({
    [LOW_LATENCY_PROFILE_ID]: 'and zero video buffer',
    [STABILIZED_PROFILE_ID]:
      'OpenCL stabilization, and 100 ms synchronized audio delay',
    [SQUARE_LEFT_PROFILE_ID]: 'and zero video buffer',
    [SQUARE_RIGHT_PROFILE_ID]: 'and zero video buffer'
  });

  function isLockedProfileId(profileId) {
    return LOCKED_PROFILE_IDS.includes(profileId);
  }

  function normalizeOutputFormat(value) {
    return value === SQUARE_OUTPUT ? SQUARE_OUTPUT : WIDESCREEN_OUTPUT;
  }

  function getLockedProfileId(profileId, outputFormat, rightEye) {
    if (!VISIBLE_PROFILE_IDS.has(profileId)) {
      throw new Error('A supported casting profile is required.');
    }
    if (normalizeOutputFormat(outputFormat) !== SQUARE_OUTPUT) {
      return profileId;
    }
    return rightEye === true ? SQUARE_RIGHT_PROFILE_ID : SQUARE_LEFT_PROFILE_ID;
  }

  function normalizePresetSelection(value) {
    return VISIBLE_PROFILE_IDS.has(value) ? value : LOW_LATENCY_PROFILE_ID;
  }

  function selectInitialProfile(storedProfile, migrationVersion) {
    if (migrationVersion !== PROFILE_MIGRATION_VERSION) {
      return LOW_LATENCY_PROFILE_ID;
    }
    return normalizePresetSelection(storedProfile);
  }

  function resolveInitialProfileSelection(storedProfile, migrationVersion) {
    const profileId = selectInitialProfile(storedProfile, migrationVersion);
    return {
      profileId,
      persist: profileId !== storedProfile || migrationVersion !== PROFILE_MIGRATION_VERSION,
    };
  }

  function buildLockedStreamPayload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Locked stream input is required.');
    }
    const profileId = getLockedProfileId(input.profileId, input.outputFormat, input.rightEye);
    if (typeof input.serial !== 'string' || !input.serial) {
      throw new Error('A valid ADB serial is required.');
    }
    if (typeof input.streamMic !== 'boolean') {
      throw new Error('Microphone stream state must be a boolean.');
    }
    return {
      serial: input.serial,
      profileId,
      streamMic: input.streamMic,
    };
  }

  function buildStreamPayload(profileId, lockedInput) {
    return buildLockedStreamPayload({ ...lockedInput, profileId });
  }

  function getProfileAvailability(preflight) {
    const result = {};
    for (const profileId of LOCKED_PROFILE_IDS) {
      const record = Array.isArray(preflight?.profiles)
        ? preflight.profiles.find((candidate) => candidate?.id === profileId)
        : null;
      result[profileId] = Object.freeze({
        available: record?.available === true,
        reason: typeof record?.reason === 'string' && record.reason
          ? record.reason
          : record?.available === true ? null : 'Preflight has not verified this profile.',
        output: record?.output || getProfileOutput(profileId),
        gpu: typeof record?.gpu === 'string' ? record.gpu : null,
        nominalDelayMs: Number.isSafeInteger(record?.nominalDelayMs)
          ? record.nominalDelayMs
          : getProfileGeometry(profileId).nominalDelayMs
      });
    }
    return Object.freeze(result);
  }

  function chooseAvailableProfile(selectedProfileId, availability) {
    if (!isLockedProfileId(selectedProfileId) || availability?.[selectedProfileId]?.available) {
      return { profileId: selectedProfileId, changed: false, persist: false };
    }
    const availableLocked = LOCKED_PROFILE_IDS.find(
      (profileId) => availability?.[profileId]?.available
    );
    return {
      profileId: availableLocked || LOW_LATENCY_PROFILE_ID,
      changed: true,
      persist: false
    };
  }

  function resolveFailedStartOwnership(previousOwnership, preservedExistingStream) {
    if (
      preservedExistingStream === true
      && previousOwnership
      && Number.isSafeInteger(previousOwnership.generation)
      && previousOwnership.generation > 0
      && typeof previousOwnership.requestedProfile === 'string'
    ) {
      return {
        generation: previousOwnership.generation,
        requestedProfile: previousOwnership.requestedProfile
      };
    }
    return { generation: null, requestedProfile: null };
  }

  function resolveProfilePersistence(savedProfileId, requestedProfileId, readyStatus) {
    if (
      !isLockedProfileId(requestedProfileId)
      || !readyStatus
      || readyStatus.requestedProfile !== requestedProfileId
      || !isLockedProfileId(readyStatus.effectiveProfile)
      || !Number.isSafeInteger(readyStatus.generation)
      || readyStatus.generation <= 0
    ) {
      return savedProfileId;
    }
    if (readyStatus.effectiveProfile === requestedProfileId) {
      return requestedProfileId;
    }
    return savedProfileId || readyStatus.effectiveProfile;
  }

  function getLockedStatusViewModel(status, activeGeneration) {
    if (
      !status
      || status.generation !== activeGeneration
      || !isLockedProfileId(status.requestedProfile)
      || !isLockedProfileId(status.effectiveProfile)
      || !Number.isSafeInteger(status.output?.width)
      || !Number.isSafeInteger(status.output?.height)
    ) {
      return null;
    }
    const fallback = status.requestedProfile === STABILIZED_PROFILE_ID
      && status.effectiveProfile === LOW_LATENCY_PROFILE_ID;
    return {
      requestedProfile: PROFILE_NAMES[status.requestedProfile],
      effectiveProfile: PROFILE_NAMES[status.effectiveProfile],
      stabilization: status.stabilization === 'openclFeaturePoint' ? 'OpenCL active' : 'Off',
      gpu: typeof status.gpu === 'string' && status.gpu ? status.gpu : 'Not used',
      output: `${status.output.width}x${status.output.height}`,
      delay: `${Number.isSafeInteger(status.estimatedDelayMs) ? status.estimatedDelayMs : 0} ms`,
      generation: String(status.generation),
      fallbackWarning: fallback
        ? `Stabilized could not start; Low Latency is active.${status.fallbackWarning ? ` ${status.fallbackWarning}` : ''}`
        : status.fallbackWarning || null
    };
  }

  // A calibrated headset reuses the existing framing controls rather than
  // adding a parallel set: 16:9 or 1:1, and which eye, already name exactly
  // the four calibrated profiles. Which path is in play is decided by whether
  // preflight found a calibration, not by anything the user has to choose.
  function resolveStreamProfile({ profileId, outputFormat, rightEye, preflight }) {
    const calibrated = preflight && preflight.calibratedProfiles;
    if (calibrated) {
      const calibratedId = getCalibratedProfileId(
        normalizeOutputFormat(outputFormat), rightEye === true);
      return {
        profileId: calibratedId,
        calibrated: true,
        availability: calibrated[calibratedId] || {
          available: false,
          reason: "This headset's calibration does not cover that framing."
        },
        tier: preflight.calibrationTier || null
      };
    }
    const lockedId = getLockedProfileId(profileId, outputFormat, rightEye);
    return {
      profileId: lockedId,
      calibrated: false,
      availability: getProfileAvailability(preflight)[lockedId],
      tier: 'measured'
    };
  }

  function buildResolvedStreamPayload(resolved, lockedInput) {
    if (!resolved || !resolved.profileId) {
      throw new Error('A resolved casting profile is required.');
    }
    if (!resolved.calibrated) {
      return buildStreamPayload(resolved.profileId, lockedInput);
    }
    if (typeof lockedInput?.serial !== 'string' || !lockedInput.serial) {
      throw new Error('A valid ADB serial is required.');
    }
    if (typeof lockedInput?.streamMic !== 'boolean') {
      throw new Error('Microphone stream state must be a boolean.');
    }
    return {
      serial: lockedInput.serial,
      profileId: resolved.profileId,
      streamMic: lockedInput.streamMic
    };
  }

  function getCalibratedNote(resolved) {
    if (!resolved || !resolved.calibrated) return null;
    const measured = resolved.tier === 'measured'
      && resolved.availability?.angleConfirmed === true;
    return measured
      ? "Streaming from this headset's measured calibration."
      : 'Streaming from a provisional calibration: the crop was measured, the '
        + 'presentation angle was not, so the image is unrotated. Sweep the '
        + 'angle and re-run the wizard to confirm it.';
  }

  function getProfileDescription(profileId) {
    return PROFILE_DESCRIPTIONS[profileId] || '';
  }

  function getLockedSettingsHelp(profileId) {
    if (!isLockedProfileId(profileId)) {
      return '';
    }
    const geometry = getProfileGeometry(profileId);
    const delivery = SETTINGS_HELP_DELIVERY[profileId]
      .replace('OUTPUT', formatOutput(profileId));
    return `Locked native settings: H.264, 40 Mbps, 60 FPS, `
      + `${geometry.serverCrop} ${SETTINGS_HELP_FRAMING[profileId]}, `
      + `${delivery}, ${SETTINGS_HELP_TAIL[profileId]}. `
      + 'The disabled values below are ignored; presentation and microphone '
      + 'controls remain available.';
  }

  function getProfileDelayText(profileId, streamMic) {
    const subjects = streamMic ? 'Game and microphone audio' : 'Game audio';
    if (profileId === STABILIZED_PROFILE_ID) {
      return `${subjects}: synchronized 100 ms delay.`;
    }
    if (
      profileId === LOW_LATENCY_PROFILE_ID
      || profileId === SQUARE_LEFT_PROFILE_ID
      || profileId === SQUARE_RIGHT_PROFILE_ID
    ) {
      return `${subjects}: no added profile delay.`;
    }
    return 'Legacy/custom audio timing follows the advanced buffer controls.';
  }

  function getStreamStartFailureState(isCasting, preservedExistingStream) {
    const retainExistingStream = isCasting === true && preservedExistingStream === true;
    return retainExistingStream
      ? { isCasting: true, statusText: 'Streaming', statusClass: 'status-dot active' }
      : { isCasting: false, statusText: 'Disconnected', statusClass: 'status-dot disconnected' };
  }

  function shouldStartStreamAfterPreflight(preflight) {
    return preflight?.success === true;
  }

  return Object.freeze({
    LOCKED_PROFILE_IDS,
    SQUARE_OUTPUT,
    WIDESCREEN_OUTPUT,
    buildLockedStreamPayload,
    buildResolvedStreamPayload,
    buildStreamPayload,
    getCalibratedNote,
    isCalibratedProfileId,
    resolveStreamProfile,
    chooseAvailableProfile,
    getLockedStatusViewModel,
    getLockedProfileId,
    getLockedSettingsHelp,
    getProfileAvailability,
    getProfileDelayText,
    getProfileDescription,
    getStreamStartFailureState,
    isLockedProfileId,
    resolveFailedStartOwnership,
    resolveInitialProfileSelection,
    resolveProfilePersistence,
    selectInitialProfile,
    shouldStartStreamAfterPreflight,
    normalizePresetSelection,
    normalizeOutputFormat
  });
}));
