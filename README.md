# Quest 3 Caster

Quest 3 Caster is a Windows Electron application for dependable Meta Quest casting through ADB and a bundled `scrcpy` runtime. Connect the headset by USB each session, scan for it in the app, and start casting.

Quest 3 and Quest 3S are calibrated and work out of the box. Other headsets can be calibrated with the included wizard.

## What the app does

- Requires a USB connection each session to authorize ADB TCP/IP on port 5555. The headset IP is detected automatically; USB may be removed once the IP is confirmed.
- Frames the cast from measurements taken on your headset's own panel and lens mask, rather than from settings you have to get right.
- Pick 16:9 or a square 1:1 crop, and which eye. That is the whole decision — there are no bitrate, codec, crop, resolution, or display-source settings to get wrong.
- On a Quest 3, offers two profiles: **Low Latency** is the default; **Stabilized** is opt-in and adds GPU work plus approximately 100 ms of synchronized delay. Stabilized is Quest 3 only.
- Lets you include the optional headset microphone, keep the headset awake, and enable bounded automatic reconnect.
- Keeps timestamped local `.txt` logs in the app-data folder. Open **Settings** to verify executable paths or open the log folder.

## Headset compatibility

| Headset | Works out of the box? |
| --- | --- |
| Meta Quest 3 | Yes |
| Meta Quest 3S | Yes |
| Meta Quest 2 | Needs a one-time calibration (see below) |
| Meta Quest Pro | Needs a one-time calibration; untested |

Casting a VR headset is not just screen mirroring. The headset renders two eyes side by side, each one seen through a lens that blacks out the corners, and the picture is tilted to match how the panels sit. To get a clean, level, single-eye image out of that, the app needs to know the exact shape of *your* headset's display.

Quest 3 and Quest 3S have both been measured, so they simply work. Anything else needs to be measured once, which takes about a minute.

## Calibrating a headset

Put the headset on, wake the display, and leave it on the Quest home menu. Then plug it in by USB.

Find your headset's serial:

```powershell
resources/native/win32-x64/adb.exe devices
```

Then measure it, passing that serial:

```powershell
npm run calibrate -- --adb resources/native/win32-x64/adb.exe --serial <serial>
```

This takes a screenshot of the headset display, works out how much of it the lenses black out, and picks the largest clean rectangle it can cast from. It prints what it found and saves it.

One step is left for you, because it cannot be measured from a screenshot: how far the picture is tilted. The wizard prints a command to try — open it, and compare the Quest menu against level. If it looks straight, you are done at 0 degrees. If it looks tilted, adjust the number until it looks right, then record it:

```powershell
npm run calibrate -- --adb resources/native/win32-x64/adb.exe --serial <serial> --angle <degrees>
```

Until you do that, the app still casts — just untilted — and tells you the tilt has not been confirmed.

Your own calibration always takes priority over anything shipped with the app, so re-running it on your own headset is always safe.

## What you actually get

The app crops one eye and hands OBS a clean image. No cropping or scaling on your side.

**Quest 3**

| Mode | You get |
| --- | --- |
| Low Latency (default) | 1792x1008 |
| 1:1 (left or right eye) | 1080x1080 |
| Stabilized (optional) | 1920x1080, plus about 100 ms of delay |

**Quest 3S**

| Mode | You get |
| --- | --- |
| 16:9 (left / right eye) | 1680x946 / 1674x942 |
| 1:1 (left / right eye) | 1446x1446 / 1472x1472 |

Every mode is H.264 at 40 Mbps and 60 FPS. The odd-looking numbers are the point: they are the largest clean area the lenses leave, so nothing is scaled or resampled on the way to OBS. Scaling it yourself afterwards is fine — just start from a sharp image.

Stabilized smooths small head shake and is Quest 3 only. It needs a GPU with OpenCL, and it adds roughly 100 ms of delay to both video and audio, kept in sync. Everything else adds no delay.

## System requirements

|  | Minimum | Recommended |
| --- | --- | --- |
| **Headset** | Meta Quest 3 or Quest 3S, Developer Mode enabled | Meta Quest 3 |
| **OS** | 64-bit Windows 10 (22H2) | 64-bit Windows 11 |
| **CPU** | Any modern 4-core x64 | 6-core or better |
| **RAM** | 8 GB | 16 GB |
| **GPU** | Any GPU with hardware H.264 decode | Discrete GPU with OpenCL 1.2+ (required for **Stabilized**) |
| **Network** | 5 GHz Wi-Fi, headset and PC on the same LAN | Wi-Fi 6 access point, PC on wired Ethernet |
| **Disk** | ~500 MB | ~500 MB |

Notes on the ones that actually matter:

- **Wi-Fi is the usual bottleneck.** The stream is H.264 at 40 Mbps. 2.4 GHz will not carry it reliably. Putting the PC on Ethernet and reserving 5 GHz (or 6 GHz) for the headset gives the most stable result.
- **OpenCL is only needed for Stabilized**, which is a Quest 3 profile. Everything else needs no GPU compute. If preflight finds no usable OpenCL device, Stabilized is offered as unavailable and the rest remains fully functional.
- **Developer Mode is enabled in the Meta Horizon phone app**, not in the headset. Devices → your headset → Headset Settings → Developer Mode.
- **OBS Studio** is not required to run the app, but is the intended capture target.

## Prerequisites (building from source)

Node.js 18 or later, in addition to the system requirements above. End users installing the release do not need Node.js — everything is bundled.

## Distribution (end-user install)

Download the latest `Quest 3 Caster Setup x.x.x.exe` from [GitHub Releases](https://github.com/SpaceRoachVR/Quest-3-Caster/releases). Run it and follow the installer. No additional software is required — Node.js, Electron, ADB, scrcpy, and all FFmpeg libraries are bundled inside the installer.

> **SmartScreen notice (unsigned build):** Windows may display a "Windows protected your PC" prompt because the installer is not yet code-signed. Click **More info → Run anyway** to proceed. This warning will be resolved in a future release once a signing certificate is added.

A portable `.zip` archive is also available on the releases page if you prefer not to use the installer.

## Building a release

```powershell
npm install
npm run native:verify        # confirm the bundled scrcpy/adb runtime is healthy
npm run dist:dir             # smoke-test the unpacked layout (no installer generated)
# Run dist/win-unpacked/Quest 3 Caster.exe and verify casting works
npm run dist                 # produce dist/Quest 3 Caster Setup x.x.x.exe + .zip
```

## Installation and launch (development)

```powershell
npm install
npm start
```

## Each session

1. Connect the headset by USB and accept the USB debugging prompt in the headset.
2. Click **Scan USB devices** in the app and select your headset.
3. Quest 3 Caster detects the local IP, enables legacy ADB TCP/IP on port 5555, and confirms readiness. The USB cable may be removed once the IP is shown.
4. Click **Start casting**. The app connects wirelessly, runs a capability preflight, and launches scrcpy.
5. Quest 3 Caster does not use Android's pairing-code workflow or Meta Horizon Link Auto-Connect because neither exposes an ADB connection the app can use.
6. USB setup is required again after every headset restart because legacy ADB TCP/IP does not survive a reboot.
7. On a Quest 3, use **Low Latency** for responsive gameplay, and choose **Stabilized** only when the GPU and display preflight succeeds and its added delay is acceptable. On a calibrated headset there is one profile per framing and nothing further to pick.
8. Use **Settings** for custom ADB/scrcpy paths, executable validation, and the rolling local log folder.

## OBS Studio

Add a **Window Capture** source and pick `[scrcpy.exe]: Quest 3 Stream (Caster)`.

**Set your canvas to match the numbers above** (Settings → Video → Base Resolution). The app hands OBS a finished image, so if your canvas is a different size OBS will stretch it and soften it for no reason. Do not add a crop filter either — the cropping is already done.

If you stream at 1080p, set the canvas to the app's size and let OBS scale once on output. That is one clean resize instead of two.

> **Upgrading from 1.0.0-beta.3 or earlier?** Low Latency used to open a 1920x1080 window even though it only produced 1792x1008, so the image was being stretched before OBS ever saw it. That is fixed. If your canvas is set to 1920x1080 for this source, change it to 1792x1008 to get the sharper image.

## How the framing is worked out

*This section is for anyone maintaining or extending the calibration; you do not need it to use the app.*

Each eye is half the display, and the headset composites it through a lens mask that blacks out roughly 16% of the panel. A usable crop is bounded by that mask rather than by the eye rectangle, so crops are found by flood-filling the mask out of a captured frame and taking the largest clean rectangle. `npm run calibrate` does this automatically; the Quest 3 numbers predate the wizard and were measured by hand the same way.

The picture also has to be rotated back, because the compositor bakes a tilt into the display buffer. On a Quest 3 the two panels are canted in opposite directions, so the correction depends on **which eye a profile crops, not on the crop's shape**: `20` for a left-eye crop, `-22` for a right-eye crop. Do not collapse these to one value. A Quest 3S has a single flat panel and needs no rotation at all — its measured angle is `0`.

Rotation samples pixels from outside the crop, which only works while that sample stays inside one eye. A crop of `w` x `h` rotated by `t` reads `w·cos t + h·sin t` pixels across the eye. On a Quest 3's 2064px eye at 22 degrees that caps the crop at about 1814px wide:

| Profile | Crop | Rotated sample | Delivered |
| --- | --- | --- | --- |
| Low Latency | `1792:1008:2200:600` | 2039px — fits | 1792x1008 |
| 1:1 left / right | `1488:1488` | 1937px — fits | 1080x1080 |
| Stabilized | `2064:1160:2064:524` | **2348px — overruns** | 1920x1080 |

Exceeding the ceiling is not a rounding error: the rotation pulls a sliver of the *other* eye into one corner and off-display black into the opposite one.

**Known issue:** the Stabilized profile ships a crop that overruns, as shown above. A `1808:1016:2192:596` crop samples 2057px and fits, but changing it needs a hardware check and a native rebuild, so Stabilized stays opt-in and unverified for now. Low Latency and both 1:1 modes are unaffected.

A stream is never reported as active until the delivered geometry is confirmed to match what was measured. On a Quest 3 that confirmation comes from the native runtime's own readiness event; on a calibrated headset it comes from scrcpy reporting its texture size, checked against the calibration. If Stabilized cannot start, it falls back once to Low Latency. Reconnect is bounded, and stopping or replacing a stream cancels anything pending.

Run this before relying on a native bundle update:

```powershell
npm run native:verify
```

On a machine with no OpenCL GPU, such as a hosted CI runner, add
`-- --allow-missing-gpu`. That still checks every file hash, the client, the
libavfilter link, forced-failure cleanup and the CLI parser, but skips the
native unit tests and the synthetic stabilization probe because both need a
live OpenCL filter. Release verification runs without the flag on a GPU.

## Audio

Game audio and the headset microphone arrive in OBS as **two separate sources**, so you can mix them, duck one under the other, or drop the mic entirely without touching the game.

Things worth knowing:

- **Sound keeps playing in the headset while you cast.** The app copies the audio rather than taking it, so you still hear your game.
- **Headset volume does not change your recording.** Audio is captured before the speakers, so turning the headset down costs the recording nothing — and it means the mic picks up less game noise bleeding through. Run it as quiet as is comfortable.
- **The mic is recorded at 256 kbps**, double scrcpy's default. A mic inside a headset is a loud, close signal and you raise your voice over the game, which is exactly when a low bit rate smears. At 256 kbps it holds up through gunfire.
- **The mic avoids the headset's echo cancellation.** Left on, that processing hears game audio bleeding into the mic, decides it is echo, and ducks your voice along with it for as long as the game is loud.

<details>
<summary>Why this needed a patched scrcpy (maintainers)</summary>

Upstream scrcpy captures **no game audio on a Quest at all**, and does not report an error. Its playback capture builds a loopback mix matching `USAGE_MEDIA` only, while Quest titles and the Horizon shell emit `USAGE_GAME`. The mix is created empty, capture succeeds, and the stream carries digital silence with nothing logged. Patch `0004` in `native/patches/` widens the mix rules, which is why the device server is built from source rather than downloaded.

Game audio uses `--audio-dup`, which duplicates the mix rather than taking it. The alternative route (`--audio-source=output`, mapped to `REMOTE_SUBMIX`) forwards the whole output but silences the headset, which is unusable while wearing it.

The microphone uses `mic-voice-recognition` rather than `mic`. The plain `MIC` source runs the Horizon OS echo-cancellation chain, whose residual suppressor clamps the whole channel — the wearer's voice included — while the game is loud; measured at 8 to 16 dB of voice suppression during loud passages. `VOICE_RECOGNITION` is tuned for speech with echo cancellation and automatic gain control disabled.

Game audio stays at scrcpy's 128 kbps default. It is a mixed and mastered signal rather than a close microphone, so it has not shown the same artefact, and its bit rate lives in the locked profile inside `native/patches/` — raising it means a server rebuild rather than a flag.

Headset volume independence was measured across a change from 14/15 to 5/15: −1.7 dBFS against −1.4 dBFS captured.

</details>

## Rebuilding the pinned Windows native bundle

The bundled runtime is intentionally pinned and verified. `npm run native:build` rebuilds it; `npm run native:verify` checks the manifest, executable capabilities, and required native probes before use. The replacement workflow supports a manifest-verified shared-library replacement only; preserve the rollback bundle until verification succeeds.

```powershell
npm run native:replace-libraries -- --source C:\path\to\replacement
```

The source directory must include a compatible `replacement-manifest.json` describing the replacement FFmpeg libraries.

## Project structure

- `main.js` — Electron lifecycle, ADB/scrcpy processes, IPC, file logging, and Windows audio control.
- `preload.js` — narrow context-isolated renderer API.
- `renderer.js` — USB scan and connect flow, cast controls, settings, and safe UI state recovery.
- `lib/device-registry.js` — which headsets are known, and how far each is calibrated.
- `lib/calibration-*.js` — reading a captured frame, measuring the lens mask, and storing the result.
- `lib/calibrated-*.js` — streaming a headset from its own calibration.
- `lib/file-logger.js` — rolling local text logs.
- `scripts/calibrate-device.js` — the calibration wizard.
- `calibration/` — measured calibrations that ship with the app.
- `native/` — pinned native profile and stabilization sources.

## Verification

```powershell
npm test
npm run native:verify
```

Also perform physical acceptance for USB authorization, legacy ADB TCP/IP setup, USB cable removal before casting, no-device/unauthorized/offline states, failed executable launch, normal stop, unexpected child exit, and OBS capture before a release.

When changing anything that touches framing, re-run the wizard against a real headset and check the numbers against the tables above. Automated tests cover the maths, not whether the picture is right.

## Support

If Quest 3 Caster saves you some setup time, you can buy me a coffee:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/D8CB4B9H5JD6S)

Or use the direct link: <https://www.paypal.com/ncp/payment/D8CB4B9H5JD6S>
