'use strict';

function createNativeContextAuthority({
  streamSession,
  operationGate,
  getCurrentContext,
  getOwnership,
}) {
  if (
    !streamSession
    || typeof streamSession.isCurrent !== 'function'
    || !operationGate
    || typeof operationGate.isCurrent !== 'function'
    || typeof getCurrentContext !== 'function'
    || typeof getOwnership !== 'function'
  ) {
    throw new TypeError('Native context authority dependencies are invalid.');
  }

  function isContextCurrent(context) {
    return Boolean(
      context
      && getCurrentContext() === context
      && streamSession.isCurrent(context.generation)
      && (context.published || operationGate.isCurrent(context.operationToken))
    );
  }

  function isAttemptCurrent(context, attemptRecord) {
    return isContextCurrent(context)
      && Boolean(attemptRecord?.attempt)
      && context.state === attemptRecord.state
      && context.state.accepts(
        attemptRecord.attempt.token,
        context.generation,
      );
  }

  function assertAttemptCompletion({
    context,
    attemptRecord,
    primaryChild,
    microphoneChild = null,
    requireMicrophone = false,
  }) {
    const ownership = getOwnership();
    if (
      !isAttemptCurrent(context, attemptRecord)
      || !attemptRecord.handle
      || typeof attemptRecord.handle.isAlive !== 'function'
      || !attemptRecord.handle.isAlive()
      || attemptRecord.boundaryFailure
      || ownership.generation !== context.generation
      || ownership.primary !== primaryChild
      || (requireMicrophone && ownership.microphone !== microphoneChild)
    ) {
      throw attemptRecord?.boundaryFailure
        || new Error('Native attempt completion is stale or no longer alive.');
    }
    return true;
  }

  function allowsReconnect(context, generation) {
    return isContextCurrent(context)
      && context.generation === generation
      && context.state.allowsReconnect();
  }

  return Object.freeze({
    allowsReconnect,
    assertAttemptCompletion,
    isAttemptCurrent,
    isContextCurrent,
  });
}

module.exports = { createNativeContextAuthority };
