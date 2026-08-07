'use strict';

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  const { scheduler, reconnectDelaysMs, onReconnect } = options;

  if (!scheduler
    || typeof scheduler.setTimeout !== 'function'
    || typeof scheduler.clearTimeout !== 'function') {
    throw new TypeError('scheduler must provide setTimeout and clearTimeout functions');
  }

  if (!Array.isArray(reconnectDelaysMs)
    || !reconnectDelaysMs.every((delay) => Number.isFinite(delay) && delay >= 0)) {
    throw new TypeError('reconnectDelaysMs must be an array of finite non-negative numbers');
  }

  if (onReconnect !== undefined && typeof onReconnect !== 'function') {
    throw new TypeError('onReconnect must be a function when provided');
  }
}

function createStreamSession(options) {
  validateOptions(options);

  const {
    scheduler,
    reconnectDelaysMs,
    onReconnect = () => {}
  } = options;
  const configuredReconnectDelaysMs = Object.freeze([...reconnectDelaysMs]);
  let currentGeneration = 0;
  let hasActiveGeneration = false;
  let retryCount = 0;
  let pendingReconnectToken = null;
  let pendingTimerKey;

  function cancelReconnect() {
    if (pendingReconnectToken !== null) {
      scheduler.clearTimeout(pendingTimerKey);
      pendingReconnectToken = null;
      pendingTimerKey = undefined;
    }
  }

  function begin() {
    cancelReconnect();
    currentGeneration += 1;
    hasActiveGeneration = true;
    retryCount = 0;
    return currentGeneration;
  }

  function isCurrent(generation) {
    return hasActiveGeneration && generation === currentGeneration;
  }

  function scheduleReconnect(generation) {
    if (!isCurrent(generation)
      || pendingReconnectToken !== null
      || retryCount >= configuredReconnectDelaysMs.length) {
      return false;
    }

    const delay = configuredReconnectDelaysMs[retryCount];
    const reconnectToken = {};
    pendingReconnectToken = reconnectToken;
    retryCount += 1;
    const timerKey = scheduler.setTimeout(() => {
      if (pendingReconnectToken !== reconnectToken) {
        return;
      }

      pendingReconnectToken = null;
      pendingTimerKey = undefined;

      if (isCurrent(generation)) {
        onReconnect(generation);
      }
    }, delay);
    if (pendingReconnectToken === reconnectToken) {
      pendingTimerKey = timerKey;
    }
    return true;
  }

  function stop() {
    cancelReconnect();
    hasActiveGeneration = false;
    currentGeneration += 1;
    retryCount = 0;
  }

  function getRetryState() {
    return Object.freeze({
      generation: currentGeneration,
      isActive: hasActiveGeneration,
      retryCount,
      retryLimit: configuredReconnectDelaysMs.length,
      hasPendingReconnect: pendingReconnectToken !== null
    });
  }

  return {
    begin,
    isCurrent,
    scheduleReconnect,
    cancelReconnect,
    stop,
    getRetryState
  };
}

module.exports = { createStreamSession };
