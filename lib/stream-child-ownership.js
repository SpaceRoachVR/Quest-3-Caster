'use strict';

function terminateChild(child) {
  if (!child || typeof child.kill !== 'function') {
    return;
  }
  try {
    child.kill();
  } catch (_error) {
    // Child shutdown is best effort; callers retain authoritative ownership state.
  }
}

function createStreamChildOwnership() {
  let primary = null;
  let microphone = null;
  let generation = null;

  function begin(nextGeneration) {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 1) {
      throw new Error('Generation must be a positive safe integer.');
    }
    terminateChild(primary);
    terminateChild(microphone);
    primary = null;
    microphone = null;
    generation = nextGeneration;
  }

  function isCurrent(candidateGeneration) {
    return generation === candidateGeneration;
  }

  function setPrimary(candidateGeneration, child) {
    if (!isCurrent(candidateGeneration) || !child) {
      return false;
    }
    if (primary && primary !== child) {
      terminateChild(primary);
    }
    primary = child;
    return true;
  }

  function setMicrophone(candidateGeneration, child) {
    if (!isCurrent(candidateGeneration) || !child) {
      return false;
    }
    if (microphone && microphone !== child) {
      terminateChild(microphone);
    }
    microphone = child;
    return true;
  }

  function clearPrimaryAndTerminateMicrophone(candidateGeneration, child) {
    if (!isCurrent(candidateGeneration) || primary !== child) {
      return false;
    }
    const activeMicrophone = microphone;
    terminateChild(activeMicrophone);
    primary = null;
    microphone = null;
    return true;
  }

  function clearMicrophone(candidateGeneration, child) {
    if (!isCurrent(candidateGeneration) || microphone !== child) {
      return false;
    }
    microphone = null;
    return true;
  }

  function stop() {
    terminateChild(primary);
    terminateChild(microphone);
    primary = null;
    microphone = null;
    generation = null;
  }

  function snapshot() {
    return { primary, microphone, generation };
  }

  return Object.freeze({
    begin,
    clearMicrophone,
    clearPrimaryAndTerminateMicrophone,
    isCurrent,
    setMicrophone,
    setPrimary,
    snapshot,
    stop
  });
}

module.exports = { createStreamChildOwnership };
