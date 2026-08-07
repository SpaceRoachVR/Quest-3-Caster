(function attachRendererLifecycle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.RendererLifecycle = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  function createActiveStreamOwnership(generation, requestedProfile, streamMic) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error('Stream generation must be a positive safe integer.');
    }
    if (typeof requestedProfile !== 'string' || !requestedProfile) {
      throw new Error('Requested stream profile is required.');
    }
    if (typeof streamMic !== 'boolean') {
      throw new Error('Accepted microphone state must be a boolean.');
    }
    return Object.freeze({ generation, requestedProfile, streamMic });
  }

  function matchesOwnership(ownership, generation, requestedProfile) {
    return Boolean(
      ownership
      && ownership.generation === generation
      && ownership.requestedProfile === requestedProfile
    );
  }

  async function requestReconnectForCurrentOwnership({
    generation,
    requestedProfile,
    getCurrentOwnership,
    requestReconnect
  }) {
    if (typeof getCurrentOwnership !== 'function' || typeof requestReconnect !== 'function') {
      throw new Error('Reconnect ownership callbacks are required.');
    }
    if (!matchesOwnership(getCurrentOwnership(), generation, requestedProfile)) {
      return { accepted: false, result: null };
    }
    const result = await requestReconnect(generation);
    if (!matchesOwnership(getCurrentOwnership(), generation, requestedProfile)) {
      return { accepted: false, result: null };
    }
    return { accepted: true, result };
  }

  return Object.freeze({
    createActiveStreamOwnership,
    matchesOwnership,
    requestReconnectForCurrentOwnership
  });
}));
