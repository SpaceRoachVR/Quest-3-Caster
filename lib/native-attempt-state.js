'use strict';

const { isLockedProfileId } = require('./locked-native-profiles');

function getExpectedOutput(profileId) {
  return profileId === 'obsLowLatencySquareLeft1080p60'
    || profileId === 'obsLowLatencySquareRight1080p60'
    ? { width: 1080, height: 1080 }
    : { width: 1920, height: 1080 };
}

function createNativeAttemptState(generation, requestedProfile, capability = {}) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Generation must be a positive safe integer.');
  }
  if (!isLockedProfileId(requestedProfile)) {
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
    if (!active || !isLockedProfileId(profileId)) {
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
    const expectedOutput = getExpectedOutput(profileId);
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
