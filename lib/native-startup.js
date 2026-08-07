'use strict';

const { createNativeLineParser } = require('./native-events');

function terminateChild(child) {
  if (!child || child.killed === true || typeof child.kill !== 'function') return;
  try {
    child.kill();
  } catch (_error) {
    // The caller receives the authoritative startup/protocol failure.
  }
}

function createNativeError(message, code = 'native_start_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function launchNativeAttempt({
  child,
  generation,
  profileId,
  expectedGpu,
  startupTimeoutMs = 10000,
  scheduler = global,
  onLog,
  onRuntimeEvent,
  onRuntimeExit,
}) {
  if (!child || typeof child.once !== 'function' || typeof child.on !== 'function') {
    return Promise.reject(createNativeError('Native child process is invalid.'));
  }
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    return Promise.reject(createNativeError('Native generation is invalid.'));
  }
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) {
    return Promise.reject(createNativeError('Native startup timeout is invalid.'));
  }
  if (
    !scheduler
    || typeof scheduler.setTimeout !== 'function'
    || typeof scheduler.clearTimeout !== 'function'
    || typeof onLog !== 'function'
    || typeof onRuntimeEvent !== 'function'
    || typeof onRuntimeExit !== 'function'
  ) {
    return Promise.reject(createNativeError('Native attempt dependencies are invalid.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    let disposed = false;
    let terminated = false;
    let alive = true;
    let timer;
    const streamListeners = [];
    const childListeners = [];

    function removeListener(emitter, event, listener) {
      if (emitter && typeof emitter.removeListener === 'function') {
        emitter.removeListener(event, listener);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.clearTimeout(timer);
      for (const [stream, listener] of streamListeners) {
        removeListener(stream, 'data', listener);
      }
      for (const [event, listener] of childListeners) {
        removeListener(child, event, listener);
      }
    }

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      alive = false;
      terminated = true;
      scheduler.clearTimeout(timer);
      terminateChild(child);
      dispose();
      reject(error);
    }

    function acceptEvent(event) {
      if (terminated) {
        return;
      }
      if (event.type === 'warning') {
        if (ready) onRuntimeEvent(event);
        else onLog(`[native warning] ${event.message}`);
        return;
      }
      if (event.type === 'fatal') {
        const error = createNativeError(event.message, event.code);
        if (ready) {
          alive = false;
          terminated = true;
          terminateChild(child);
          dispose();
          onRuntimeEvent(event);
        } else {
          fail(error);
        }
        return;
      }
      if (ready) {
        const error = createNativeError(
          'Native process emitted duplicate readiness.',
          'native_protocol_error',
        );
        alive = false;
        terminated = true;
        terminateChild(child);
        dispose();
        onRuntimeEvent({
          schemaVersion: 1,
          type: 'fatal',
          code: error.code,
          message: error.message,
        });
        return;
      }
      const stabilized = profileId === 'obsStabilized1080p60';
      if (
        event.generation !== generation
        || event.effectiveProfile !== profileId
        // Output dimensions are validated per profile in native-events.js.
        // Repeating a hard-coded 1920x1080 here is what silently rejected every
        // square-eye stream: they legitimately deliver 1080x1080.
        || event.stabilization?.active !== stabilized
        || event.nominalDelayMs !== (stabilized ? 100 : 0)
        || (stabilized ? event.gpu !== expectedGpu : event.gpu !== null)
      ) {
        fail(createNativeError(
          'Native ready event does not match the active attempt.',
          'native_protocol_error',
        ));
        return;
      }
      ready = true;
      settled = true;
      scheduler.clearTimeout(timer);
      resolve(Object.freeze({
        child,
        ready: event,
        dispose,
        isAlive: () => alive && !terminated,
      }));
    }

    function attachOutput(stream) {
      if (!stream || typeof stream.on !== 'function') return;
      const parser = createNativeLineParser({
        onEvent: acceptEvent,
        onLog: (line) => {
          if (line) onLog(line);
        },
      });
      const listener = (data) => {
        try {
          parser.push(data);
        } catch (error) {
          fail(createNativeError(
            `Native protocol failure: ${error.message}`,
            'native_protocol_error',
          ));
        }
      };
      streamListeners.push([stream, listener]);
      stream.on('data', listener);
    }

    attachOutput(child.stdout);
    attachOutput(child.stderr);
    const errorListener = (error) => {
      if (terminated) return;
      if (!ready) {
        fail(createNativeError(
          `Failed to launch native client: ${error.message}`,
          'native_spawn_failed',
        ));
        return;
      }
      alive = false;
      terminated = true;
      dispose();
      onRuntimeExit(Object.freeze({
        code: -1,
        signal: null,
        error: error.message,
      }));
    };
    const exitListener = (code, signal) => {
      if (terminated) return;
      if (!ready) {
        fail(createNativeError(
          `Native client exited before native readiness (code ${code}, signal ${signal}).`,
          'native_pre_ready_exit',
        ));
        return;
      }
      alive = false;
      terminated = true;
      dispose();
      onRuntimeExit(Object.freeze({ code, signal, error: null }));
    };
    childListeners.push(['error', errorListener], ['exit', exitListener]);
    child.once('error', errorListener);
    child.once('exit', exitListener);
    timer = scheduler.setTimeout(() => fail(createNativeError(
      'Native client timed out before native readiness.',
      'native_startup_timeout',
    )), startupTimeoutMs);
  });
}

module.exports = { launchNativeAttempt };
