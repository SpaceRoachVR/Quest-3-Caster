'use strict';

const { TextDecoder } = require('node:util');
const { LOCKED_PROFILE_GEOMETRY, getProfileOutput } = require('./locked-profile-geometry');

const NATIVE_EVENT_PREFIX = 'Q3C_NATIVE_EVENT ';
const MAX_JSON_BYTES = 4096;
const MAX_PENDING_BYTES = Buffer.byteLength(NATIVE_EVENT_PREFIX) + MAX_JSON_BYTES;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_IDS = new Set(Object.keys(LOCKED_PROFILE_GEOMETRY));
const EVENT_TYPES = new Set(['ready', 'warning', 'fatal']);
const READY_CODES = new Set(['stream_ready']);
const DIAGNOSTIC_CODES = new Set([
  'stabilization_unavailable',
  'stabilization_degraded',
  'latency_limit_exceeded',
  'invalid_frame',
  'render_failed',
  'native_protocol_error',
  'unexpected_output_geometry',
  'unexpected_input_geometry',
  'invalid_video_timestamp',
]);

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
}

function validateDiagnosticText(value, label, maximumLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`${label} is invalid or contains a control character.`);
  }
}

function validateNativeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Native event must be an object.');
  }
  if (event.schemaVersion !== 1 || !EVENT_TYPES.has(event.type)) {
    throw new Error('Native event schema or type is unsupported.');
  }
  if (event.type === 'ready') {
    requireExactKeys(event, [
      'schemaVersion',
      'type',
      'code',
      'effectiveProfile',
      'output',
      'stabilization',
      'gpu',
      'nominalDelayMs',
      'generation',
    ], 'Native ready event');
    if (!READY_CODES.has(event.code)) {
      throw new Error('Native ready code is unsupported.');
    }
    if (!PROFILE_IDS.has(event.effectiveProfile)) {
      throw new Error('Native ready profile is unsupported.');
    }
    requireExactKeys(event.output, ['width', 'height'], 'Native ready output');
    requireExactKeys(event.stabilization, ['active'], 'Native ready stabilization');
    // The native client reports each profile's real delivered size. These must
    // stay in step with profile.c: Low Latency crops 1792x1008 so its rotated
    // sample stays inside one eye, Stabilized still delivers 1920x1080, and the
    // square eyes deliver 1080x1080.
    const expected = getProfileOutput(event.effectiveProfile);
    if (event.output.width !== expected.width || event.output.height !== expected.height) {
      throw new Error(
        `Native ${event.effectiveProfile} output must be exactly `
        + `${expected.width}x${expected.height}.`
      );
    }
    if (!Number.isSafeInteger(event.generation) || event.generation <= 0) {
      throw new Error('Native ready generation must be a positive safe integer.');
    }
    const stabilized = event.effectiveProfile === 'obsStabilized1080p60';
    if (
      event.stabilization.active !== stabilized
      || event.nominalDelayMs !== (stabilized ? 100 : 0)
      || (stabilized
        ? typeof event.gpu !== 'string' || event.gpu.length === 0 || event.gpu.length > 256
        : event.gpu !== null)
    ) {
      throw new Error('Native ready stabilization, GPU, or delay is inconsistent.');
    }
    if (stabilized && CONTROL_CHARACTER_PATTERN.test(event.gpu)) {
      throw new Error('Native ready GPU contains a control character.');
    }
    return event;
  }

  requireExactKeys(
    event,
    ['schemaVersion', 'type', 'code', 'message'],
    'Native diagnostic event',
  );
  validateDiagnosticText(event.code, 'Native diagnostic code', 64);
  validateDiagnosticText(event.message, 'Native diagnostic message', MAX_JSON_BYTES);
  if (!DIAGNOSTIC_CODES.has(event.code)) {
    throw new Error('Native diagnostic code is unsupported.');
  }
  return event;
}

function createNativeLineParser({ onEvent, onLog }) {
  if (typeof onEvent !== 'function' || typeof onLog !== 'function') {
    throw new TypeError('Native line parser callbacks are required.');
  }
  let pending = '';
  let ended = false;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  function processLine(line) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.startsWith(NATIVE_EVENT_PREFIX)) {
      onLog(normalized);
      return;
    }
    const json = normalized.slice(NATIVE_EVENT_PREFIX.length);
    if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
      throw new Error('Native protocol event payload is oversized.');
    }
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new Error(`Native protocol event contains invalid JSON: ${error.message}`);
    }
    onEvent(validateNativeEvent(parsed));
  }

  function push(chunk) {
    if (ended) {
      throw new Error('Native line parser has ended.');
    }
    if (typeof chunk !== 'string') {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('Native output chunk must be a string or Buffer.');
      }
      try {
        chunk = utf8Decoder.decode(chunk, { stream: true });
      } catch (error) {
        throw new Error(`Native output is not valid UTF-8: ${error.message}`);
      }
    } else if (/[\ud800-\udfff]/.test(chunk)) {
      throw new Error('Native output string contains an invalid Unicode surrogate.');
    }
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_PENDING_BYTES) {
        throw new Error('Native protocol line is oversized.');
      }
      processLine(line);
      newlineIndex = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_PENDING_BYTES) {
      throw new Error('Native output contains oversized unterminated data.');
    }
  }

  function end() {
    if (ended) return;
    ended = true;
    try {
      pending += utf8Decoder.decode();
    } catch (error) {
      throw new Error(`Native output is not valid UTF-8: ${error.message}`);
    }
    if (pending.length > 0) {
      processLine(pending);
      pending = '';
    }
  }

  return Object.freeze({ push, end });
}

module.exports = {
  MAX_JSON_BYTES,
  NATIVE_EVENT_PREFIX,
  createNativeLineParser,
  validateNativeEvent,
};
