# Quest 3 Caster

Quest 3 Caster is a Windows Electron application for dependable Meta Quest 3 casting through ADB and a bundled `scrcpy` runtime. Connect the headset by USB each session, scan for it in the app, and start casting.

## What the app does

- Requires a USB connection each session to authorize ADB TCP/IP on port 5555. The headset IP is detected automatically; USB may be removed once the IP is confirmed.
- Uses two locked profiles: **Low Latency** is the default; **Stabilized** is opt-in and adds GPU work plus approximately 100 ms of synchronized delay.
- Locks H.264, Opus, Display 0, calibrated crop, resolution, FPS, buffering, and presentation in the native runtime. Choose either calibrated 16:9 output or a locked 1:1 eye crop; 1:1 reveals a Right eye switch and otherwise uses the left eye. There are no bitrate, codec, crop, FOV, resolution, or display-source controls to misconfigure.
- Lets you include the optional headset microphone, keep the headset awake, and enable bounded automatic reconnect.
- Keeps timestamped local `.txt` logs in the app-data folder. Open **Settings** to verify executable paths or open the log folder.

## Headset compatibility

**Quest 3 ships calibrated. Other headsets can be calibrated with the wizard.**

The capture profiles are calibrated against a specific panel: the crops come from that panel's lens mask, and the rotation correction from its panel cant. A headset the app has never measured cannot borrow another one's crops without mis-framing the cast, so preflight reports calibration status per device rather than assuming one display size.

`lib/device-registry.js` records what is known about each headset and how it came to be known:

| Tier | Meaning |
| --- | --- |
| `measured` | Crops and angle came off real hardware. Selectable by default. |
| `provisional` | Derived, or measured but not physically confirmed. Offered and labelled, never the default. |
| `uncalibrated` | Nothing measured. Framing is not claimed to be correct. |

| Headset | Display | Status |
| --- | --- | --- |
| Meta Quest 3 | 4128x2208 | `measured` |
| Meta Quest 3S | 3664x1920 | `uncalibrated` — run the wizard |
| Meta Quest 2 | 3664x1920 | `uncalibrated` — run the wizard |
| Meta Quest Pro | 3600x1920 | `uncalibrated`, not on the roadmap |

Quest 2 and Quest 3S report the same display size, so geometry alone cannot tell them apart; preflight reads `ro.product.model` and falls back to geometry only when the model is unknown.

## Calibrating a headset

The wizard runs the same procedure the Quest 3 profiles were built from -- capture a frame, flood-fill the lens mask out of it, measure the largest mask-free crop -- against whatever headset is plugged in. Being per-unit rather than per-model, it is also better data than a shipped table.

Put the headset on the Quest home menu with the display awake, then:

```powershell
npm run calibrate -- --serial <serial>
```

It prints the mask fraction and the largest mask-free 16:9 and 1:1 crop for each eye, and writes `calibration/<device>.json`.

That result is **provisional**, and deliberately so. The lens mask can be derived from a still frame; the panel cant cannot. Deriving a horizon from one barrel-distorted frame would produce a confident answer that silently tilts every cast, so the wizard leaves the angle unmeasured and tells you how to sweep it. Use the right-eye crop it printed and judge against the Quest menu, which is roll-locked to gravity and therefore a valid horizontal reference:

```powershell
scrcpy -s <serial> --crop <crop> --angle -22
```

Calibrate against the centre of frame -- the source is barrel-distorted, so no single angle levels every region at once. Then record the angle you settled on, which promotes the file to `measured`:

```powershell
npm run calibrate -- --serial <serial> --angle <degrees>
```

A saved frame can be analysed without a headset attached, which is how a calibration can be reviewed or reproduced later:

```powershell
npm run calibrate -- --frame capture.png --model "Quest 3S"
```

Calibrations are searched for in the app's user data directory first and the repository's `calibration/` directory second, so your own measurement of your own headset always outranks anything shipped.

## How a calibrated headset streams

A calibrated headset does not use the locked native profiles. Those carry their crops inside `profile.c`, so they only fit the headset those crops were measured on; a calibrated device supplies its own crop and angle and drives upstream scrcpy's `--crop` and `--angle` instead. Supporting a headset is then a matter of measuring it rather than rebuilding the native runtime.

The framing controls mean the same thing on both paths — 16:9 or 1:1, and which eye — so there is nothing extra to choose. Preflight decides which path applies based on whether a calibration exists, and the app says which one it used.

What the calibrated path gives up is the fork's own event protocol: no stabilization, and no single fallback to Low Latency, because there is no second profile to fall back to. What it does not give up is the rule that a stream is never reported active until its geometry is confirmed. Upstream scrcpy prints `INFO: Texture: <width>x<height>` once it has decoded a frame and sized its texture, and the app matches that against the measured crop before reporting the stream live — the same guarantee the native ready event provides, from a different signal. If the delivered geometry ever stops matching the calibration mid-stream, that is fatal rather than a warning.

A provisional calibration streams unrotated and says so in the profile note, because an unmeasured angle is not a reason to refuse to cast — only a reason not to claim the framing is confirmed.

## System requirements

|  | Minimum | Recommended |
| --- | --- | --- |
| **Headset** | Meta Quest 3, Developer Mode enabled | Meta Quest 3 |
| **OS** | 64-bit Windows 10 (22H2) | 64-bit Windows 11 |
| **CPU** | Any modern 4-core x64 | 6-core or better |
| **RAM** | 8 GB | 16 GB |
| **GPU** | Any GPU with hardware H.264 decode | Discrete GPU with OpenCL 1.2+ (required for **Stabilized**) |
| **Network** | 5 GHz Wi-Fi, headset and PC on the same LAN | Wi-Fi 6 access point, PC on wired Ethernet |
| **Disk** | ~500 MB | ~500 MB |

Notes on the ones that actually matter:

- **Wi-Fi is the usual bottleneck.** The stream is H.264 at 40 Mbps. 2.4 GHz will not carry it reliably. Putting the PC on Ethernet and reserving 5 GHz (or 6 GHz) for the headset gives the most stable result.
- **OpenCL is only needed for Stabilized.** Low Latency and both 1:1 modes need no GPU compute. If preflight finds no usable OpenCL device, Stabilized is offered as unavailable and Low Latency remains fully functional.
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
2. Click **Scan USB devices** in the app and select your Quest 3.
3. Quest 3 Caster detects the local IP, enables legacy ADB TCP/IP on port 5555, and confirms readiness. The USB cable may be removed once the IP is shown.
4. Click **Start casting**. The app connects wirelessly, runs a capability preflight, and launches scrcpy.
5. Quest 3 Caster does not use Android's pairing-code workflow or Meta Horizon Link Auto-Connect because neither exposes an ADB connection the app can use.
6. USB setup is required again after every headset restart because legacy ADB TCP/IP does not survive a reboot.
7. Use **Low Latency** for responsive gameplay. Choose **Stabilized** only when the GPU and display preflight succeeds and its added delay is acceptable.
8. Use **Settings** for custom ADB/scrcpy paths, executable validation, and the rolling local log folder.

## Calibrated OBS capture profiles

The native runtime owns the image-quality contract. On a verified 4128x2208 Quest 3 display each eye occupies a 2064x2208 half, and every profile crops one eye and lets the device downscale to the delivered size.

The Quest composites each eye through a lens mask that leaves 16.6% of the display black, so a crop is bounded by the mask, not by the 2064x2208 eye rectangle. Crops below were chosen by flood-filling the mask out of a captured frame and measuring intrusion directly.

- **Low Latency** crops the right eye at `1792:1008:2200:600` and delivers **1792x1008** with no resampling anywhere in the pipeline. H.264 at 40 Mbps/60 FPS, zero video buffer.
- **1:1 modes** crop `1488:1488:288:360` (left) or `1488:1488:2352:360` (right) and the device downscales to **1080x1080**. Mask intrusion 0.00%, covering 72% of the eye width against 52% for a native 1080x1080 crop.
- **Stabilized** crops `1808:1016:2192:596` as OpenCL stabilization headroom and centre-crops to **1680x944** after filtering. It stays 16:9-only because its filter pipeline is calibrated for that geometry.

`presentation_angle` cancels the rotation the compositor bakes into the display buffer. Quest 3's two display panels are physically canted in opposite directions, so each eye is pre-rotated the opposite way. **The correction therefore depends on which eye a profile crops, not on the crop's shape:**

| Eye | Angle | Profiles |
| --- | --- | --- |
| Left (x < 2064) | `20` | 1:1 left |
| Right (x >= 2064) | `-22` | Low Latency, Stabilized, 1:1 right |

Measured on hardware against the Quest menu, which is roll-locked to gravity and therefore a valid horizontal reference. Note that three of the four profiles crop the right eye, so `-22` is the common case and a left-eye profile is the exception. Do not collapse these to one shared value, and do not derive them from the crop dimensions — a 16:9 right-eye crop and a square right-eye crop need the *same* angle, while two square crops of opposite eyes need *opposite* angles.

`addCrop` and `addAngle` compose into a single affine transform that samples the full display texture, so the rotation pulls in real pixels from outside the crop rather than black — **provided the rotated sample stays inside one eye.**

**Every crop is sized so the rotated sample stays inside one eye.** A crop of width `w` and height `h` rotated by 22° samples `w·cos22 + h·sin22` pixels across the 2064px eye, so the crop width is capped at 1814px:

| Profile | Crop | Rotated sample | Delivered |
| --- | --- | --- | --- |
| Low Latency | `1792:1008:2200:600` | 2039px — fits | 1792x1008 |
| Stabilized | `1808:1016:2192:596` | 2057px — fits | 1680x944 after filtering |
| 1:1 left / right | `1488:1488` | 1937px — fits | 1080x1080 |

Exceeding that ceiling is not a rounding error: a `1920x1080` crop samples 2185px and pulls a sliver of the *other* eye into one corner with off-display black in the opposite one.

To re-calibrate, sweep `--angle` on unlocked scrcpy with the shipping crop and judge against the Quest menu. Because the source is barrel-distorted, no single angle levels every region at once — calibrate against the centre of frame.

The application never reports a stream active until the native process confirms readiness. If Stabilized cannot satisfy preflight or fails during start, it falls back exactly once to Low Latency. Reconnect is generation-safe and bounded; a stop or replacement cancels pending reconnects.

Run this before relying on a native bundle update:

```powershell
npm run native:verify
```

Stabilized remains opt-in until the physical Quest and OBS acceptance checklist passes. Verify actual framing, no seam or fisheye edge, A/V sync within ±50 ms, and no more than 120 ms added delay. Also physically confirm the new left/right 1:1 framing before relying on either square crop in a production recording. Automated tests do not satisfy those physical gates; restore Low Latency 16:9 if a physical check fails.

## OBS Studio

Use Window Capture and select `[scrcpy.exe]: Quest 3 Stream (Caster)`. The locked profiles already produce the final calibrated image (1792x1008 for Low Latency, 1680x944 for Stabilized, 1080x1080 for the 1:1 modes); do not apply manual crop corrections in OBS.

## Audio

Game audio and the headset microphone arrive as two separate scrcpy processes, so OBS can capture and mix them independently.

Game audio uses playback capture with `--audio-dup`, which duplicates the mix rather than taking it, so **sound keeps playing in the headset while casting**. The alternative capture route (`--audio-source=output`, mapped to `REMOTE_SUBMIX`) forwards the whole output but silences the headset, which is unusable while wearing it, so the locked profiles do not use it.

Two Quest-specific behaviours are worth knowing, because both look like an application bug and neither reports an error:

- **Upstream scrcpy captures no game audio on a Quest at all.** Its playback capture builds a loopback mix matching `USAGE_MEDIA` only, and Quest titles and the Horizon shell emit `USAGE_GAME`. The mix is created empty, capture succeeds, and the stream carries digital silence with nothing logged. Patch `0004` in `native/patches/` widens the mix rules, which is why the device server is built from source rather than downloaded.
- **The microphone uses `mic-voice-recognition`, not `mic`.** The plain `MIC` source runs the Horizon OS echo-cancellation chain. Headset speakers bleed into the microphone, that chain treats game audio as echo, and its residual suppressor clamps the whole channel — the wearer's voice included — for as long as the game is loud. `VOICE_RECOGNITION` is tuned for speech with echo cancellation and automatic gain control disabled, and a side-by-side listening comparison of the two sources recorded from the same speech and the same game audio is clearly better on `VOICE_RECOGNITION`.

The microphone stream is encoded at **256 kbps** rather than scrcpy's 128 kbps default. A close microphone worn inside a headset is a hot, dense signal, and the wearer raises their voice over loud game audio, so the encoder runs out of bits exactly when the material is hardest. At 128 kbps that smears audibly through gunfire; at 256 kbps it is indistinguishable from an uncompressed capture of the same scene.

Game audio still uses the 128 kbps default. It is a mixed and mastered signal rather than a close microphone, so it has not shown the same artefact, and its bit rate lives in the locked profile inside `native/patches/` — raising it means a server rebuild rather than a flag.

### Headset volume does not affect the recording

Game audio is captured inside Android's audio policy, upstream of the speaker amplifier, so **the headset volume control has no effect on the level OBS receives.** Measured across a change from 14/15 to 5/15: −1.7 dBFS against −1.4 dBFS captured. Run the headset as quiet as is comfortable; it costs the recording nothing and reduces how much game audio the microphone picks up acoustically.

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
- `lib/file-logger.js` — rolling local text logs.
- `native/` — pinned native profile and stabilization sources.

## Verification

```powershell
npm test
npm run native:verify
```

Also perform physical acceptance for USB authorization, legacy ADB TCP/IP setup, USB cable removal before casting, no-device/unauthorized/offline states, failed executable launch, normal stop, unexpected child exit, and OBS capture before a release.

## Support

If Quest 3 Caster saves you some setup time, you can buy me a coffee:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/D8CB4B9H5JD6S)

Or use the direct link: <https://www.paypal.com/ncp/payment/D8CB4B9H5JD6S>
