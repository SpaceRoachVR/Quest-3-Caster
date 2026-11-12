'use strict';

// A process that was killed by a signal has a null exitCode and a non-null
// signalCode, so both must be checked before calling it running.
function isChildRunning(child) {
  return Boolean(child && Number.isSafeInteger(child.pid) && child.pid > 0
    && child.killed !== true
    && child.exitCode === null
    && (child.signalCode === null || child.signalCode === undefined));
}

function hasCurrentLivePrimary(sessionState, ownershipSnapshot) {
  if (!sessionState || !ownershipSnapshot || sessionState.isActive !== true ||
      !Number.isSafeInteger(sessionState.generation) ||
      sessionState.hasPendingReconnect === true ||
      ownershipSnapshot.generation !== sessionState.generation) {
    return false;
  }

  return isChildRunning(ownershipSnapshot.primary);
}

function createStartFailureResult(error, hadActiveStream, replacementStarted) {
  const message = error instanceof Error ? error.message : String(error || 'Unable to start stream.');
  return {
    success: false,
    error: message,
    preservedExistingStream: hadActiveStream === true && replacementStarted === false
  };
}

function shouldCleanupFailedStart({
  replacementStarted,
  startedGeneration,
  currentGeneration,
  sessionActive
}) {
  return replacementStarted === true &&
    sessionActive === true &&
    Number.isSafeInteger(startedGeneration) &&
    startedGeneration > 0 &&
    startedGeneration === currentGeneration;
}

module.exports = {
  createStartFailureResult,
  hasCurrentLivePrimary,
  isChildRunning,
  shouldCleanupFailedStart
};
