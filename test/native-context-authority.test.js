'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNativeContextAuthority } = require('../lib/native-context-authority');
const { createNativeAttemptState } = require('../lib/native-attempt-state');

function fixture() {
  let currentContext = null;
  let ownership = { generation: null, primary: null, microphone: null };
  let activeGeneration = null;
  let currentOperation = null;
  const authority = createNativeContextAuthority({
    streamSession: { isCurrent: (generation) => generation === activeGeneration },
    operationGate: { isCurrent: (token) => token === currentOperation },
    getCurrentContext: () => currentContext,
    getOwnership: () => ownership,
  });
  return {
    authority,
    setContext(value) { currentContext = value; },
    setOwnership(value) { ownership = value; },
    setGeneration(value) { activeGeneration = value; },
    setOperation(value) { currentOperation = value; },
  };
}

test('slow old context cannot complete after a newer context replaces it', () => {
  const f = fixture();
  const operation = {};
  const state = createNativeAttemptState(2, 'obsLowLatency1080p60');
  const attempt = state.beginAttempt('obsLowLatency1080p60');
  const oldContext = {
    generation: 2,
    operationToken: operation,
    published: false,
    state,
  };
  const primary = {};
  const record = {
    attempt,
    state,
    handle: { isAlive: () => true },
    boundaryFailure: null,
  };
  f.setContext(oldContext);
  f.setGeneration(2);
  f.setOperation(operation);
  f.setOwnership({ generation: 2, primary, microphone: null });
  assert.equal(f.authority.assertAttemptCompletion({
    context: oldContext,
    attemptRecord: record,
    primaryChild: primary,
  }), true);

  f.setContext({ generation: 3 });
  f.setGeneration(3);
  assert.throws(() => f.authority.assertAttemptCompletion({
    context: oldContext,
    attemptRecord: record,
    primaryChild: primary,
  }), /stale/i);
});

test('microphone completion revalidates captured primary and mic ownership', () => {
  const f = fixture();
  const operation = {};
  const state = createNativeAttemptState(4, 'obsStabilized1080p60', { gpu: 'GPU' });
  const attempt = state.beginAttempt('obsStabilized1080p60');
  const context = {
    generation: 4,
    operationToken: operation,
    published: false,
    state,
  };
  const primary = {};
  const microphone = {};
  const record = {
    attempt,
    state,
    handle: { isAlive: () => true },
    boundaryFailure: null,
  };
  f.setContext(context);
  f.setGeneration(4);
  f.setOperation(operation);
  f.setOwnership({ generation: 4, primary, microphone });
  assert.equal(f.authority.assertAttemptCompletion({
    context,
    attemptRecord: record,
    primaryChild: primary,
    microphoneChild: microphone,
    requireMicrophone: true,
  }), true);
  const replacementState = createNativeAttemptState(
    4,
    'obsStabilized1080p60',
    { gpu: 'GPU' },
  );
  replacementState.beginAttempt('obsStabilized1080p60');
  context.state = replacementState;
  assert.throws(() => f.authority.assertAttemptCompletion({
    context,
    attemptRecord: record,
    primaryChild: primary,
    microphoneChild: microphone,
    requireMicrophone: true,
  }), /stale/i);
  context.state = state;
  f.setOwnership({ generation: 4, primary: {}, microphone });
  assert.throws(() => f.authority.assertAttemptCompletion({
    context,
    attemptRecord: record,
    primaryChild: primary,
    microphoneChild: microphone,
    requireMicrophone: true,
  }), /stale/i);
});

test('dead ready-boundary handle and terminal fallback cannot publish or reconnect', () => {
  const f = fixture();
  const operation = {};
  const state = createNativeAttemptState(6, 'obsStabilized1080p60', { gpu: 'GPU' });
  const attempt = state.beginAttempt('obsStabilized1080p60');
  const context = {
    generation: 6,
    operationToken: operation,
    published: false,
    state,
  };
  const primary = {};
  const record = {
    attempt,
    state,
    handle: { isAlive: () => false },
    boundaryFailure: null,
  };
  f.setContext(context);
  f.setGeneration(6);
  f.setOperation(operation);
  f.setOwnership({ generation: 6, primary, microphone: null });
  assert.throws(() => f.authority.assertAttemptCompletion({
    context,
    attemptRecord: record,
    primaryChild: primary,
  }), /stale/i);
  state.markFallbackTerminal();
  context.published = true;
  assert.equal(f.authority.allowsReconnect(context, 6), false);
});
