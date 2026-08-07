'use strict';

function hasCurrentLivePrimary(sessionState, ownershipSnapshot) {
  if (!sessionState || !ownershipSnapshot || sessionState.isActive !== true ||
      !Number.isSafeInteger(sessionState.generation) ||
      ownershipSnapshot.generation !== sessionState.generation) {
    return false;
  }

  const primary = ownershipSnapshot.primary;
  return Boolean(primary && Number.isSafeInteger(primary.pid) && primary.pid > 0 &&
    primary.killed !== true && primary.exitCode === null);
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
  shouldCleanupFailedStart
};
