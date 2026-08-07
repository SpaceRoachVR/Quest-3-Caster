'use strict';

function createStartOperationGate() {
  let sequence = 0;
  let currentToken = null;

  function begin() {
    const token = Object.freeze({ sequence: ++sequence });
    currentToken = token;
    return token;
  }

  function invalidate() {
    sequence += 1;
    currentToken = null;
  }

  function isCurrent(token) {
    return token !== null && token === currentToken;
  }

  function assertCurrent(token) {
    if (!isCurrent(token)) {
      const error = new Error('Stream start operation was superseded or stopped.');
      error.code = 'stream_start_superseded';
      throw error;
    }
  }

  return Object.freeze({ begin, invalidate, isCurrent, assertCurrent });
}

module.exports = { createStartOperationGate };
