#!/usr/bin/env node
'use strict';

// The self-calibration wizard.
//
// README documents calibration as something the maintainer does by hand, on
// hardware they own: capture a frame, flood-fill the lens mask out of it,
// measure the intrusion, then sweep `--angle` against the Quest menu until the
// horizon sits level. That is why Quest 3S support has been "planned" rather
// than shipped -- it is gated on somebody owning the headset and doing the
// measurement.
//
// This runs the same procedure automatically against whatever headset is
// plugged in, which makes it per-unit rather than per-model, and it means a
// 3S owner can calibrate their own headset instead of waiting.
//
// It does not guess the panel cant. Deriving a horizon from one barrel-
// distorted frame would be a plausible-looking answer that silently tilts
// every cast, so the angle stays null and the run stays `provisional` until
// somebody sweeps it physically and records the result with --angle.
//
//   node scripts/calibrate-device.js --serial <serial>
//   node scripts/calibrate-device.js --serial <serial> --angle -22
//   node scripts/calibrate-device.js --frame capture.png --model "Quest 3S"

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { decodeScreencapPng } = require('../lib/png-decode');
const { parseWmSizes, describeDisplayOverride } = require('../lib/display-geometry');
const { identifyDevice } = require('../lib/device-registry');
const { buildCalibrationFile } = require('../lib/calibration-file');
const {
  analyzeEye,
  buildAngleSweep,
  detectMask,
} = require('../lib/calibration-analysis');

const MAX_SCREENCAP_BYTES = 128 * 1024 * 1024;

function parseArguments(argv) {
  const options = {
    serial: null,
    adb: process.env.ADB_PATH || 'adb',
    frame: null,
    model: null,
    angle: null,
    out: null,
    saveFrame: null,
  };
  for (let i = 0; i < argv.length; ++i) {
    const argument = argv[i];
    const [flag, inlineValue] = argument.startsWith('--') && argument.includes('=')
      ? argument.split(/=(.*)/s)
      : [argument, null];
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    switch (flag) {
      case '--serial': options.serial = takeValue(); break;
      case '--adb': options.adb = takeValue(); break;
      case '--frame': options.frame = takeValue(); break;
      case '--model': options.model = takeValue(); break;
      case '--out': options.out = takeValue(); break;
      case '--save-frame': options.saveFrame = takeValue(); break;
      case '--angle': {
        const value = Number(takeValue());
        if (!Number.isFinite(value) || Math.abs(value) > 90) {
          throw new Error('--angle must be a number of degrees between -90 and 90.');
        }
        options.angle = value;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}.`);
    }
  }
  return options;
}

function usage() {
  return [
    'Measure a headset\'s lens mask and derive calibrated crops.',
    '',
    'Usage:',
    '  node scripts/calibrate-device.js --serial <serial> [options]',
    '  node scripts/calibrate-device.js --frame <capture.png> [options]',
    '',
    'Options:',
    '  --serial <serial>   ADB serial of the headset to capture from.',
    '  --adb <path>        ADB executable (default: $ADB_PATH or "adb").',
    '  --frame <path>      Analyse an existing PNG instead of capturing.',
    '  --model <name>      Headset model, when analysing a saved frame.',
    '  --angle <degrees>   Presentation angle you confirmed by sweeping against',
    '                      the Quest menu. Without it the run stays provisional.',
    '  --save-frame <path> Write the captured frame alongside the calibration.',
    '  --out <path>        Calibration output (default: calibration/<id>.json).',
    '',
    'Put the headset on the Quest home menu, with the display awake, before',
    'capturing. The menu is roll-locked to gravity, so the same frame doubles',
    'as the reference for the angle sweep.',
  ].join('\n');
}

function run(executable, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: MAX_SCREENCAP_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        reject(new Error(`${executable} ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function captureFromDevice(options) {
  const target = ['-s', options.serial];
  const model = (await run(options.adb, [...target, 'shell', 'getprop', 'ro.product.model']))
    .trim() || null;
  const sizes = parseWmSizes(
    await run(options.adb, [...target, 'shell', 'wm', 'size']));
  const displaySize = sizes.override || sizes.physical;
  if (!displaySize) {
    throw new Error('Could not read the headset display size.');
  }
  const overrideWarning = describeDisplayOverride(sizes);
  // `exec-out` rather than `shell` because the payload is binary; `shell`
  // corrupts it outright on most platforms.
  const png = await run(options.adb, [...target, 'exec-out', 'screencap', '-p'],
    { binary: true });
  return { model, displaySize, png, overrideWarning };
}

function loadFrame(options) {
  const png = fs.readFileSync(options.frame);
  const image = decodeScreencapPng(png);
  return {
    model: options.model,
    displaySize: { width: image.width, height: image.height },
    png,
    overrideWarning: null,
  };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function describeAnalysis(label, analysis) {
  if (!analysis.crop) {
    return `  ${label.padEnd(18)} unusable -- ${analysis.reason}`;
  }
  const flag = analysis.usable ? ' ' : '!';
  return `${flag} ${label.padEnd(18)} ${analysis.crop.padEnd(22)}`
    + ` ${String(analysis.rect.width)}x${analysis.rect.height}`
    + `  mask ${percent(analysis.maskIntrusionFraction)}`
    + `  covers ${percent(analysis.eyeCoverage)} of the eye`;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help || (!options.serial && !options.frame)) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = options.help ? 0 : 2;
    return;
  }

  const captured = options.frame ? loadFrame(options) : await captureFromDevice(options);
  if (captured.overrideWarning) {
    // Calibrating against an override measures the override, not the panel.
    throw new Error(`${captured.overrideWarning} Calibrate with the panel at its native size.`);
  }
  if (options.saveFrame) {
    fs.mkdirSync(path.dirname(path.resolve(options.saveFrame)), { recursive: true });
    fs.writeFileSync(options.saveFrame, captured.png);
  }

  const image = decodeScreencapPng(captured.png);
  if (image.width !== captured.displaySize.width
    || image.height !== captured.displaySize.height) {
    process.stderr.write(
      `Warning: the frame is ${image.width}x${image.height} but the display reports `
      + `${captured.displaySize.width}x${captured.displaySize.height}. `
      + 'Measuring the frame.\n');
  }
  const frameSize = { width: image.width, height: image.height };
  const identification = identifyDevice({ model: captured.model, displaySize: frameSize });
  const device = identification.device;

  process.stdout.write(`\nHeadset:  ${device.name}${captured.model ? ` (${captured.model})` : ''}\n`);
  process.stdout.write(`Display:  ${frameSize.width}x${frameSize.height}`
    + `  eye ${device.eye.width}x${device.eye.height}\n`);
  if (identification.reason) {
    process.stdout.write(`Note:     ${identification.reason}\n`);
  }

  const mask = detectMask(image);
  process.stdout.write(`Mask:     ${percent(mask.maskedFraction)} of the display is lens mask\n\n`);
  if (mask.maskedFraction > 0.9) {
    throw new Error(
      'Almost the whole frame is black. Capture with the headset awake and worn, '
      + 'on the Quest home menu.');
  }

  // The angle caps how wide a crop can be, so crops are measured at the angle
  // that will actually be applied. Without a confirmed angle, 0 is the only
  // honest assumption -- and it is also the most permissive, which is why the
  // run stays provisional rather than shipping the widest crop as fact.
  const angle = options.angle === null ? 0 : options.angle;
  const analyses = {
    widescreenLeft: analyzeEye(mask, 'left', { aspectWidth: 16, aspectHeight: 9, angleDegrees: angle }),
    widescreenRight: analyzeEye(mask, 'right', { aspectWidth: 16, aspectHeight: 9, angleDegrees: angle }),
    squareLeft: analyzeEye(mask, 'left', { aspectWidth: 1, aspectHeight: 1, angleDegrees: angle }),
    squareRight: analyzeEye(mask, 'right', { aspectWidth: 1, aspectHeight: 1, angleDegrees: angle }),
  };
  for (const analysis of Object.values(analyses)) {
    analysis.angleDegrees = options.angle;
  }

  process.stdout.write(`Crops at ${angle} degrees:\n`);
  process.stdout.write(describeAnalysis('16:9 left', analyses.widescreenLeft) + '\n');
  process.stdout.write(describeAnalysis('16:9 right', analyses.widescreenRight) + '\n');
  process.stdout.write(describeAnalysis('1:1 left', analyses.squareLeft) + '\n');
  process.stdout.write(describeAnalysis('1:1 right', analyses.squareRight) + '\n\n');

  const calibration = buildCalibrationFile({
    model: captured.model,
    deviceId: device.id,
    displaySize: frameSize,
    eyeSize: device.eye,
    capturedAt: new Date().toISOString(),
    maskedFraction: mask.maskedFraction,
    profiles: analyses,
    angleSweep: options.angle === null ? buildAngleSweep({ from: -30, to: 30, step: 2 }) : [],
    angleConfirmed: options.angle !== null,
    notes: options.frame ? `Analysed from ${path.basename(options.frame)}.` : null,
  });

  const outputPath = path.resolve(
    options.out || path.join('calibration', `${device.id}.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(calibration, null, 2)}\n`);
  process.stdout.write(`Calibration (${calibration.calibration}) written to ${outputPath}\n`);

  if (options.angle === null) {
    process.stdout.write([
      '',
      'The crops are measured. The panel cant is not, and cannot be read off a',
      'still frame -- a wrong angle tilts every cast without looking broken.',
      'To finish the calibration, sweep the angle on unlocked scrcpy using the',
      'right-eye crop above, judging against the Quest menu, which is',
      'roll-locked to gravity:',
      '',
      `  scrcpy -s ${options.serial || '<serial>'} --crop `
        + `${analyses.widescreenRight.crop || '<crop>'} --angle -22`,
      '',
      'Calibrate against the centre of frame: the source is barrel-distorted,',
      'so no single angle levels every region at once. Then re-run with the',
      'angle you settled on to promote this to a measured calibration:',
      '',
      `  node scripts/calibrate-device.js --serial ${options.serial || '<serial>'} --angle <degrees>`,
      '',
    ].join('\n'));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
