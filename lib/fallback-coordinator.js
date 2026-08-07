'use strict';

function createFallbackCoordinator({ state, cancelReconnect, onTerminal }) {
  if (
    !state
    || typeof state.requestFallback !== 'function'
    || typeof state.markFallbackTerminal !== 'function'
    || typeof cancelReconnect !== 'function'
    || typeof onTerminal !== 'function'
  ) {
    throw new TypeError('Fallback coordinator dependencies are invalid.');
  }
  let terminalReported = false;

  function request(attemptToken, reason) {
    const action = state.requestFallback(attemptToken, reason);
    if (action === 'begin') {
      cancelReconnect();
      return 'begin';
    }
    if (action === 'terminal') {
      terminate('Stabilization fallback budget is exhausted.');
      return 'terminal';
    }
    return 'ignore';
  }

  function terminate(reason) {
    state.markFallbackTerminal();
    if (terminalReported) return;
    terminalReported = true;
    cancelReconnect();
    onTerminal(reason);
  }

  return Object.freeze({ request, terminate });
}

module.exports = { createFallbackCoordinator };
