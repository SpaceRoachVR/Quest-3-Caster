'use strict';

const { terminateChild } = require('./terminate-child');

// Readiness for the calibrated path.
//
// The locked path waits for the fork's own `Q3C_NATIVE_EVENT` ready line,
// which echoes the generation and the delivered geometry. A calibrated stream
// runs stock scrcpy, so that protocol does not exist -- but the guarantee it
// provides has to survive, because the app's core promise is that it never
// reports a stream active until the geometry is confirmed.
//
// Upstream scrcpy prints `INFO: Texture: <width>x<height>` on stdout when it
// creates the frame texture, which happens once a frame has actually been
// decoded. That line is a real readiness signal and it carries the delivered
// size, so matching it against the calibrated crop confirms both that the
// stream started and that it is framed as measured. Verified against scrcpy
// 4.1 on a Quest 3S: a `1674:942:1930:452` crop reports `Texture: 1674x942`,
// and `--angle` does not change it -- rotation happens at render time, after
// the texture is sized.

const TEXTURE_PATTERN = /^INFO:\s*Texture:\s*(\d+)x(\d+)\s*$/;
const MAX_PENDING_BYTES = 1 << 20;

function createCalibratedError(message, code = 'calibrated_start_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Line splitter over a byte stream. Kept here rather than shared with the
// native parser because that one enforces the event protocol's framing rules;
// this one only needs whole lines out of arbitrary scrcpy logging.
function createLineReader(onLine) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      if (pending.length > MAX_PENDING_BYTES) {
        throw new Error('scrcpy emitted an unreasonably long line.');
      }
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        onLine(line);
        index = pending.indexOf('\n');
      }
    },
    end() {
      if (pending) {
        const line = pending.replace(/\r$/, '');
        pending = '';
        onLine(line);
      }
    },
  };
}

function launchCalibratedAttempt({
  child,
  generation,
  profileId,
  expectedOutput,
  startupTimeoutMs = 15000,
  scheduler = global,
  onLog,
  onRuntimeEvent,
  onRuntimeExit,
}) {
  if (!child || typeof child.once !== 'function' || typeof child.on !== 'function') {
    return Promise.reject(createCalibratedError('Calibrated child process is invalid.'));
  }
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    return Promise.reject(createCalibratedError('Calibrated generation is invalid.'));
  }
  if (
    !expectedOutput
    || !Number.isSafeInteger(expectedOutput.width) || expectedOutput.width <= 0
    || !Number.isSafeInteger(expectedOutput.height) || expectedOutput.height <= 0
  ) {
    return Promise.reject(createCalibratedError('Calibrated expected output is invalid.'));
  }
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) {
    return Promise.reject(createCalibratedError('Calibrated startup timeout is invalid.'));
  }
  if (
    !scheduler
    || typeof scheduler.setTimeout !== 'function'
    || typeof scheduler.clearTimeout !== 'function'
    || typeof onLog !== 'function'
    || typeof onRuntimeEvent !== 'function'
    || typeof onRuntimeExit !== 'function'
  ) {
    return Promise.reject(createCalibratedError('Calibrated attempt dependencies are invalid.'));
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
    const readers = [];

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
      if (settled) return;
      settled = true;
      alive = false;
      terminated = true;
      scheduler.clearTimeout(timer);
      terminateChild(child);
      dispose();
      reject(error);
    }

    function acceptLine(line) {
      if (terminated) return;
      const match = TEXTURE_PATTERN.exec(line.trim());
      if (!match) {
        if (line) onLog(line);
        return;
      }
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (ready) {
        // scrcpy re-announces the texture if the source geometry changes under
        // it. The same size again is a no-op; a different one means the stream
        // is no longer framed the way it was confirmed, which the caller has
        // to treat as fatal rather than keep reporting as a good stream.
        if (width !== expectedOutput.width || height !== expectedOutput.height) {
          alive = false;
          terminated = true;
          terminateChild(child);
          dispose();
          onRuntimeEvent(Object.freeze({
            schemaVersion: 1,
            type: 'fatal',
            code: 'unexpected_output_geometry',
            message: `Stream geometry changed to ${width}x${height}; `
              + `the calibrated framing is ${expectedOutput.width}x${expectedOutput.height}.`,
          }));
        }
        return;
      }
      if (width !== expectedOutput.width || height !== expectedOutput.height) {
        fail(createCalibratedError(
          `Calibrated stream delivered ${width}x${height} but the measured crop is `
          + `${expectedOutput.width}x${expectedOutput.height}.`,
          'calibrated_geometry_mismatch',
        ));
        return;
      }
      ready = true;
      settled = true;
      scheduler.clearTimeout(timer);
      resolve(Object.freeze({
        child,
        ready: Object.freeze({
          schemaVersion: 1,
          type: 'ready',
          code: 'stream_ready',
          effectiveProfile: profileId,
          output: Object.freeze({ width, height }),
          stabilization: Object.freeze({ active: false }),
          gpu: null,
          nominalDelayMs: 0,
          generation,
        }),
        dispose,
        isAlive: () => alive && !terminated,
      }));
    }

    function attachOutput(stream) {
      if (!stream || typeof stream.on !== 'function') return;
      const reader = createLineReader(acceptLine);
      readers.push(reader);
      const listener = (data) => {
        try {
          reader.push(data);
        } catch (error) {
          fail(createCalibratedError(
            `Calibrated stream output failure: ${error.message}`,
            'calibrated_protocol_error',
          ));
        }
      };
      streamListeners.push([stream, listener]);
      stream.on('data', listener);
    }

    function flushReaders() {
      for (const reader of readers) {
        if (terminated) return;
        try {
          reader.end();
        } catch (_error) {
          // A trailing partial line cannot carry readiness; the exit or error
          // path below reports the authoritative failure.
        }
      }
    }

    attachOutput(child.stdout);
    attachOutput(child.stderr);

    const errorListener = (error) => {
      if (terminated) return;
      flushReaders();
      if (terminated) return;
      if (!ready) {
        fail(createCalibratedError(
          `Failed to launch calibrated stream: ${error.message}`,
          'calibrated_spawn_failed',
        ));
        return;
      }
      alive = false;
      terminated = true;
      dispose();
      onRuntimeExit(Object.freeze({ code: -1, signal: null, error: error.message }));
    };
    const exitListener = (code, signal) => {
      if (terminated) return;
      flushReaders();
      if (terminated) return;
      if (!ready) {
        fail(createCalibratedError(
          `Calibrated stream exited before readiness (code ${code}, signal ${signal}).`,
          'calibrated_pre_ready_exit',
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
    timer = scheduler.setTimeout(() => fail(createCalibratedError(
      'Calibrated stream timed out before readiness.',
      'calibrated_startup_timeout',
    )), startupTimeoutMs);
  });
}

module.exports = { launchCalibratedAttempt };
