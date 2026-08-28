'use strict';

const PHYSICAL_SIZE_PATTERN = /Physical\s+size:\s*(\d+)x(\d+)/i;
const OVERRIDE_SIZE_PATTERN = /Override\s+size:\s*(\d+)x(\d+)/i;

function parseWmSizeLine(output, pattern) {
  const match = pattern.exec(output);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    ? { width, height }
    : null;
}

function parseWmSizes(output) {
  if (typeof output !== 'string') {
    return { physical: null, override: null };
  }
  return {
    physical: parseWmSizeLine(output, PHYSICAL_SIZE_PATTERN),
    override: parseWmSizeLine(output, OVERRIDE_SIZE_PATTERN)
  };
}

// `wm size` prints the physical line first and adds an override line only when
// one is set. The override is the resolution the device is actually running,
// so it is what scrcpy captures and what the calibrated crops have to be
// judged against. A single `(?:Physical|Override)` alternation matched
// whichever line came first -- always the physical one -- so an override
// silently validated the crops against a resolution that was not on screen.
function parseWmSize(output) {
  const { physical, override } = parseWmSizes(output);
  return override || physical;
}

function describeDisplayOverride(geometry) {
  const override = geometry && geometry.override;
  if (!override) {
    return null;
  }
  const physical = geometry.physical;
  const physicalText = physical ? ` The panel is ${physical.width}x${physical.height}.` : '';
  return `A display size override of ${override.width}x${override.height} is active on the headset,`
    + ` so the calibrated crops do not match what the device is rendering.${physicalText}`
    + ' Run "adb shell wm size reset" to clear it.';
}

module.exports = {
  describeDisplayOverride,
  parseWmSize,
  parseWmSizes
};
