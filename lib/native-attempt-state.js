'use strict';

const { isLockedProfileId } = require('./locked-native-profiles');
const { isCalibratedProfileId } = require('./calibrated-profiles');
const { getProfileOutput, hasProfileGeometry } = require('./locked-profile-geometry');

// The calibrated path reuses this state machine: same generation and token
// discipline, same cancellation rules. What it never uses is the stabilization
// fallback, which `requestFallback` already refuses for anything that is not
// the Stabilized profile, so no calibrated stream can reach `beginFallback`.
function isSupportedProfileId(profileId) {
  return isLockedProfileId(profileId) || isCalibratedProfileId(profileId);
}

function createNativeAttemptState(generation, requestedProfile, capability = {}) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Generation must be a positive safe integer.');
  }
  if (!isSupportedProfileId(requestedProfile)) {
    throw new Error('Requested profile is unsupported.');
  }
  let active = true;
  let tokenSequence = 0;
  let activeAttempt = null;
  let fallbackStatus = 'available';
  let fallbackWarning = null;
  let effectiveProfile = requestedProfile;
  let ready = false;

  function accepts(token, candidateGeneration) {
    return active
      && candidateGeneration === generation
      && activeAttempt !== null
      && activeAttempt.token === token;
  }

  function beginAttempt(profileId) {
    if (!active || !isSupportedProfileId(profileId)) {
      throw new Error('Cannot begin an inactive or unsupported attempt.');
    }
    const token = Object.freeze({ sequence: ++tokenSequence });
    activeAttempt = Object.freeze({ token, profileId });
    effectiveProfile = profileId;
    ready = false;
    return activeAttempt;
  }

  function requestFallback(token, warning) {
    if (!accepts(token, generation)) {
      return 'stale';
    }
    if (fallbackStatus === 'pending') {
      return 'pending';
    }
    if (
      requestedProfile !== 'obsStabilized1080p60'
      || fallbackStatus === 'used'
      || fallbackStatus === 'terminal'
    ) {
      fallbackStatus = 'terminal';
      return 'terminal';
    }
    fallbackStatus = 'pending';
    fallbackWarning = typeof warning === 'string' && warning
      ? warning
      : 'Stabilization became unavailable; using OBS Low Latency.';
    return 'begin';
  }

  function beginFallback(previousToken) {
    if (
      !active
      || fallbackStatus !== 'pending'
      || !activeAttempt
      || activeAttempt.token !== previousToken
    ) {
      return null;
    }
    fallbackStatus = 'used';
    return beginAttempt('obsLowLatency1080p60');
  }

  function validateReady(token, event) {
    if (!accepts(token, event && event.generation)) {
      throw new Error('Native ready event is stale.');
    }
    const profileId = activeAttempt.profileId;
    const stabilized = profileId === 'obsStabilized1080p60';
    // A calibrated profile's size comes from its calibration file rather than
    // the native profile table, so the caller supplies it.
    const expectedOutput = hasProfileGeometry(profileId)
      ? getProfileOutput(profileId)
      : capability.expectedOutput;
    if (!expectedOutput) {
      throw new Error('No expected output is known for the active attempt.');
    }
    if (
      event.effectiveProfile !== profileId
      || event.output?.width !== expectedOutput.width
      || event.output?.height !== expectedOutput.height
      || event.stabilization?.active !== stabilized
      || event.nominalDelayMs !== (stabilized ? 100 : 0)
      || (stabilized
        ? event.gpu !== capability.gpu
        : event.gpu !== null)
    ) {
      throw new Error('Native ready event does not match the active attempt.');
    }
    return true;
  }

  function markReady(token) {
    if (!accepts(token, generation)) {
      throw new Error('Cannot mark a stale native attempt ready.');
    }
    ready = true;
  }

  function cancel() {
    active = false;
    if (fallbackStatus === 'pending') {
      fallbackStatus = 'terminal';
    }
    activeAttempt = null;
    ready = false;
  }

  function markFallbackTerminal() {
    fallbackStatus = 'terminal';
  }

  function allowsReconnect() {
    return active && fallbackStatus !== 'pending' && fallbackStatus !== 'terminal';
  }

  function snapshot() {
    return Object.freeze({
      generation,
      requestedProfile,
      effectiveProfile,
      fallbackUsed: fallbackStatus !== 'available',
      fallbackPending: fallbackStatus === 'pending',
      fallbackStatus,
      fallbackWarning,
      ready,
      active,
    });
  }

  return Object.freeze({
    accepts,
    beginAttempt,
    beginFallback,
    cancel,
    markReady,
    markFallbackTerminal,
    allowsReconnect,
    requestFallback,
    snapshot,
    validateReady,
  });
}

module.exports = { createNativeAttemptState };
