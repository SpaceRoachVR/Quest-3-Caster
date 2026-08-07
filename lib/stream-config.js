'use strict';

const PRODUCTION_DISPLAY = Object.freeze({ width: 4128, height: 2208 });
const PRODUCTION_CROP = '1920:1080:2208:564';
const ENCODER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const CROP_PATTERN = /^(\d+):(\d+):(\d+):(\d+)$/;
const VIDEO_CODECS = new Set(['h264', 'h265']);
const AUDIO_SOURCES = new Set(['output', 'playback', 'mic']);
const AUDIO_CODECS = new Set(['opus', 'aac', 'raw']);

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function assertDisplaySize(displaySize) {
  if (!displaySize || typeof displaySize !== 'object') {
    throw new Error('Display size is required.');
  }

  assertPositiveSafeInteger(displaySize.width, 'Display width');
  assertPositiveSafeInteger(displaySize.height, 'Display height');
}

function parseCrop(value) {
  if (typeof value !== 'string') {
    throw new Error('Crop must use width:height:x:y format.');
  }

  const match = CROP_PATTERN.exec(value);
  if (!match) {
    throw new Error('Crop must use width:height:x:y format.');
  }

  const [width, height, x, y] = match.slice(1).map(Number);
  if (![width, height, x, y].every(Number.isSafeInteger)) {
    throw new Error('Crop values must be safe integers.');
  }
  if (width <= 0 || height <= 0) {
    throw new Error('Crop width and height must be positive.');
  }

  return { width, height, x, y };
}

function validateCrop(crop, displaySize, alignment) {
  if (!crop || typeof crop !== 'object') {
    throw new Error('Crop is required.');
  }
  assertDisplaySize(displaySize);
  assertPositiveSafeInteger(alignment, 'Encoder alignment');

  const normalizedCrop = {
    width: crop.width,
    height: crop.height,
    x: crop.x,
    y: crop.y
  };

  assertPositiveSafeInteger(normalizedCrop.width, 'Crop width');
  assertPositiveSafeInteger(normalizedCrop.height, 'Crop height');
  assertNonNegativeSafeInteger(normalizedCrop.x, 'Crop x');
  assertNonNegativeSafeInteger(normalizedCrop.y, 'Crop y');

  if (normalizedCrop.x + normalizedCrop.width > displaySize.width ||
      normalizedCrop.y + normalizedCrop.height > displaySize.height) {
    throw new Error('Crop is outside display bounds.');
  }
  if (Object.values(normalizedCrop).some((part) => part % alignment !== 0)) {
    throw new Error(`Crop values must satisfy encoder alignment ${alignment}.`);
  }

  return normalizedCrop;
}

function isNominalSixteenByNine(size) {
  const expectedRatio = 16 / 9;
  const actualRatio = size.width / size.height;
  return Math.abs(actualRatio - expectedRatio) / expectedRatio <= 0.01;
}

function floorToAlignment(value, alignment) {
  return Math.floor(value / alignment) * alignment;
}

function calculateOutputSize(sourceSize, maximumSize, alignment) {
  assertDisplaySize(sourceSize);
  assertPositiveSafeInteger(alignment, 'Encoder alignment');
  if (maximumSize !== null) {
    assertPositiveSafeInteger(maximumSize, 'Maximum size');
  }

  const sourceLongestEdge = Math.max(sourceSize.width, sourceSize.height);
  const scale = maximumSize === null || sourceLongestEdge <= maximumSize
    ? 1
    : maximumSize / sourceLongestEdge;
  let width = sourceSize.width * scale;
  let height = sourceSize.height * scale;

  // Quest's established 1776x993 crop is a display-coordinate representation
  // of a 16:9 eye. Preserve that intended aspect before encoder alignment.
  if (scale < 1 && isNominalSixteenByNine(sourceSize)) {
    if (sourceSize.width >= sourceSize.height) {
      height = width * 9 / 16;
    } else {
      width = height * 16 / 9;
    }
  }

  const output = {
    width: floorToAlignment(width, alignment),
    height: floorToAlignment(height, alignment)
  };
  if (output.width <= 0 || output.height <= 0) {
    throw new Error('Maximum size is too small for the required encoder alignment.');
  }
  return output;
}

function getProductionProfile(displaySize) {
  if (!displaySize || displaySize.width !== PRODUCTION_DISPLAY.width || displaySize.height !== PRODUCTION_DISPLAY.height) {
    return null;
  }
  return {
    id: 'obs1080p60', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', displayBuffer: 0, crop: PRODUCTION_CROP
  };
}

function filterH264Encoders(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines.reduce((encoders, line) => {
    if (typeof line !== 'string') {
      return encoders;
    }
    const match = /^\s*([A-Za-z0-9._-]+)\s+\(h264\)\s*$/i.exec(line);
    if (match && !encoders.includes(match[1])) {
      encoders.push(match[1]);
    }
    return encoders;
  }, []);
}

function validateAdbSerial(serial) {
  if (typeof serial !== 'string' || serial.length === 0 || serial.length > 255 || serial.trim() !== serial) {
    throw new Error('A valid ADB serial is required.');
  }

  const wirelessMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(serial);
  if (wirelessMatch) {
    const octets = wirelessMatch[1].split('.').map(Number);
    const port = Number(wirelessMatch[2]);
    if (octets.every((octet) => octet >= 0 && octet <= 255) && port >= 1 && port <= 65535) {
      return serial;
    }
    throw new Error('A valid ADB serial is required.');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(serial)) {
    throw new Error('A valid ADB serial is required.');
  }
  return serial;
}

function validateOptionalEnum(value, allowedValues, name) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new Error(`Unsupported ${name}.`);
  }
  return value;
}

function validateStreamConfig(config, displaySize) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Stream configuration is required.');
  }
  assertDisplaySize(displaySize);

  const serial = validateAdbSerial(config.serial);
  if (!VIDEO_CODECS.has(config.videoCodec)) {
    throw new Error('Unsupported video codec.');
  }
  if (!Number.isSafeInteger(config.bitRate) || config.bitRate < 1 || config.bitRate > 50) {
    throw new Error('Video bitrate must be between 1 and 50 Mbps.');
  }
  if (config.maxFps !== null && (!Number.isSafeInteger(config.maxFps) || config.maxFps < 1 || config.maxFps > 120)) {
    throw new Error('FPS must be between 1 and 120.');
  }
  if (config.maxSize !== null && (!Number.isSafeInteger(config.maxSize) || config.maxSize < 1 || config.maxSize > 8192)) {
    throw new Error('Maximum size must be between 1 and 8192.');
  }
  if (config.maxSize === null &&
      (displaySize.width !== PRODUCTION_DISPLAY.width || displaySize.height !== PRODUCTION_DISPLAY.height)) {
    throw new Error('Uncapped streams require the verified production display.');
  }
  if (!Number.isSafeInteger(config.displayBuffer) || config.displayBuffer < 0 || config.displayBuffer > 1000) {
    throw new Error('Display buffer must be between 0 and 1000 milliseconds.');
  }
  if (config.maxSize === null && (
    config.crop !== PRODUCTION_CROP ||
    config.videoCodec !== 'h264' ||
    config.bitRate !== 40 ||
    config.maxFps !== 60 ||
    config.displayBuffer !== 0
  )) {
    throw new Error('An uncapped production profile is required; otherwise a max size is required.');
  }
  if (typeof config.crop !== 'string') {
    throw new Error('Crop is required.');
  }
  const crop = validateCrop(parseCrop(config.crop), displaySize, 2);
  if (config.videoEncoder !== undefined && config.videoEncoder !== null &&
      (typeof config.videoEncoder !== 'string' || !ENCODER_NAME_PATTERN.test(config.videoEncoder))) {
    throw new Error('Video encoder name is invalid.');
  }
  if (config.noAudio !== undefined && typeof config.noAudio !== 'boolean') {
    throw new Error('Audio state must be a boolean.');
  }
  if (config.audioBuffer !== undefined && config.audioBuffer !== null &&
      (!Number.isSafeInteger(config.audioBuffer) || config.audioBuffer < 0 || config.audioBuffer > 1000)) {
    throw new Error('Audio buffer must be between 0 and 1000 milliseconds.');
  }
  if (config.audioDup !== undefined && typeof config.audioDup !== 'boolean') {
    throw new Error('Audio duplication state must be a boolean.');
  }

  validateOptionalEnum(config.audioSource, AUDIO_SOURCES, 'audio source');
  validateOptionalEnum(config.audioCodec, AUDIO_CODECS, 'audio codec');

  return {
    ...config,
    serial,
    crop: `${crop.width}:${crop.height}:${crop.x}:${crop.y}`
  };
}

function buildScrcpyArguments(config, scrcpyMajorVersion) {
  if (!Number.isSafeInteger(scrcpyMajorVersion) || scrcpyMajorVersion < 1) {
    throw new Error('scrcpy major version must be a positive integer.');
  }

  if (!config || typeof config !== 'object' || !Object.hasOwn(config, 'displaySize')) {
    throw new Error('A display size is required to build scrcpy arguments.');
  }

  const validatedConfig = validateStreamConfig(config, config.displaySize);
  const args = [
    '-s', validatedConfig.serial,
    '-b', `${validatedConfig.bitRate}M`
  ];

  if (validatedConfig.maxFps !== null) {
    args.push('--max-fps', String(validatedConfig.maxFps));
  }
  if (validatedConfig.maxSize !== null) {
    args.push('-m', String(validatedConfig.maxSize));
  }
  args.push('--video-codec', validatedConfig.videoCodec, '--crop', validatedConfig.crop);

  args.push(scrcpyMajorVersion >= 3
    ? `--video-buffer=${validatedConfig.displayBuffer}`
    : `--display-buffer=${validatedConfig.displayBuffer}`);
  if (validatedConfig.videoEncoder) {
    args.push('--video-encoder', validatedConfig.videoEncoder);
  }

  if (validatedConfig.noAudio === true) {
    args.push('--no-audio');
  } else {
    args.push('--audio-source', 'playback');
    if (validatedConfig.audioBuffer > 0) {
      args.push(`--audio-buffer=${validatedConfig.audioBuffer}`);
    }
    if (validatedConfig.audioCodec && validatedConfig.audioCodec !== 'opus') {
      args.push('--audio-codec', validatedConfig.audioCodec);
    }
    args.push('--audio-dup');
  }

  return args;
}

function formatOutputEstimate({ width, height }) {
  const tier = height >= 1440 ? ' (1440p)' : height >= 1080 ? ' (1080p)' : '';
  return 'Expected stream: ' + width + 'x' + height + tier;
}

module.exports = {
  parseCrop,
  validateCrop,
  calculateOutputSize,
  getProductionProfile,
  filterH264Encoders,
  validateAdbSerial,
  validateStreamConfig,
  buildScrcpyArguments,
  formatOutputEstimate
};
