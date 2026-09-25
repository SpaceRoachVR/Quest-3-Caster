'use strict';

// The cast is locked to 60 FPS, but a Quest compositor runs at 72, 80, 90, or
// 120 Hz depending on the headset setting and the running app. Only a rate that
// divides evenly by 60 produces a steady cadence; 90 -> 60 is a 3:2 pattern and
// 72 -> 60 is 6:5, both of which read as judder on pans even when the bitrate
// is perfect. The rate is read from `dumpsys display` so the user can be told
// before they notice it in a recording.

const CAST_FPS = 60;
const MIN_HZ = 24;
const MAX_HZ = 240;
const ACTIVE_MODE_PATTERN = /\bmode\s+(\d+)\b/;
const MODE_ENTRY_PATTERN = /\{id=(\d+)[^{}]*?\bfps=([\d.]+)/g;
const OVERRIDE_PATTERN = /refreshRateOverride\s+([\d.]+)/;
const FALLBACK_PATTERNS = [
  /\bfps=([\d.]+)/,
  /\brefreshRate[= ]([\d.]+)/,
  /\bmRefreshRate=([\d.]+)/,
  /refresh-rate\s*:\s*([\d.]+)/i
];

function toHz(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_HZ || parsed > MAX_HZ) {
    return null;
  }
  return Math.round(parsed);
}

function parseDefaultDisplayInfo(output) {
  // The first DisplayInfo block is the built-in panel. Secondary and virtual
  // displays follow it and must not be allowed to answer for the headset.
  const match = /DisplayInfo\{([\s\S]*?)\}\s*$/m.exec(output)
    || /DisplayInfo\{([\s\S]*)/.exec(output);
  return match ? match[1] : null;
}

function parseActiveModeFps(block) {
  const activeMode = ACTIVE_MODE_PATTERN.exec(block);
  if (!activeMode) {
    return null;
  }
  const activeId = activeMode[1];
  MODE_ENTRY_PATTERN.lastIndex = 0;
  let entry;
  while ((entry = MODE_ENTRY_PATTERN.exec(block)) !== null) {
    if (entry[1] === activeId) {
      return toHz(entry[2]);
    }
  }
  return null;
}

function parseRefreshRateHz(output) {
  if (typeof output !== 'string' || !output.trim()) {
    return null;
  }
  const block = parseDefaultDisplayInfo(output);
  if (block) {
    const override = OVERRIDE_PATTERN.exec(block);
    const overrideHz = override ? toHz(override[1]) : null;
    if (overrideHz) {
      return overrideHz;
    }
    const activeHz = parseActiveModeFps(block);
    if (activeHz) {
      return activeHz;
    }
  }
  for (const pattern of FALLBACK_PATTERNS) {
    const match = pattern.exec(output);
    const hz = match ? toHz(match[1]) : null;
    if (hz) {
      return hz;
    }
  }
  return null;
}

function isEvenCadence(hz) {
  return Number.isInteger(hz) && hz > 0 && hz % CAST_FPS === 0;
}

// Null when the rate is unknown or already divides evenly into the cast rate.
// Games choose their own refresh rate on a Quest, so the headset setting is a
// recommendation rather than a guarantee, and the message says so.
function describeRefreshRate(hz) {
  if (hz === null || hz === undefined || isEvenCadence(hz)) {
    return null;
  }
  return `The headset display is running at ${hz} Hz. The cast is ${CAST_FPS} FPS,`
    + ` so frames drop unevenly and pans look juddery.`
    + ' Set the headset to 120 Hz (Settings > System > Display) for smooth motion;'
    + ' games that pick their own refresh rate still override that.';
}

module.exports = {
  CAST_FPS,
  describeRefreshRate,
  isEvenCadence,
  parseRefreshRateHz
};
