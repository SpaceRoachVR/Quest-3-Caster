'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('extends the pinned patch series with modular native profile and filter logic', () => {
  const series = read('native/patches/series').trim().split(/\r?\n/);
  assert.deepEqual(series, [
    '0001-enable-libavfilter-opencl-link-proof.patch',
    '0002-add-locked-obs-profiles-and-opencl-stabilizer.patch',
    '0003-add-locked-square-eye-profiles.patch',
    '0004-capture-quest-game-audio-usages.patch',
  ]);

  const patch = read(`native/patches/${series[1]}`);
  for (const productionUnit of [
    'app/src/q3c/profile.c',
    'app/src/q3c/native_event.c',
    'app/src/q3c/stabilization_filter.c',
    'app/src/q3c/stabilization_sink.c',
  ]) {
    assert.match(patch, new RegExp(productionUnit.replaceAll('/', '\\/')));
  }
  assert.match(patch, /deshake_opencl/);
  assert.match(patch, /smooth_strength=0\.0/);
  assert.match(patch, /refine_features=1/);
  assert.match(patch, /smooth_window_multiplier=0\.1/);
  assert.match(patch, /adaptive_crop=0/);
  // Stabilized keeps its original 2064x1160 crop and 1920x1080 filter output.
  // Unlike Low Latency it has NOT been narrowed to fit the rotation, so its
  // rotated sample still overruns the eye -- see the known issue in README.md.
  assert.match(patch, /crop=1920:1080:\(iw-1920\)\/2:\(ih-1080\)\/2/);
  assert.match(patch, /2064.*1160/);
  assert.match(patch, /1920.*1080/);
  assert.match(patch, /FFFrameQueueGlobal fqg/);
  assert.match(patch, /ff_framequeue_init\(&ctx->fq, &ctx->fqg\)/);

  const patchPathCapture = patch.indexOf(
    'FFMPEG_PATCH_DIRECTORY="$PWD/patches/ffmpeg"',
  );
  const sourceDirectoryChange = patch.indexOf('cd "$SOURCES_DIR"');
  assert.ok(patchPathCapture >= 0, 'FFmpeg patch path must be captured absolutely');
  assert.ok(
    sourceDirectoryChange > patchPathCapture,
    'FFmpeg patch path must be captured before the dependency script changes directory',
  );
});

test('builds and stages production-C native tests and real OpenCL probes', () => {
  const build = read('native/build-windows.sh');
  for (const artifact of [
    'q3c-native-tests.exe',
    'q3c-stabilization-probe.exe',
  ]) {
    assert.match(build, new RegExp(artifact.replace('.', '\\.')));
  }
  assert.match(build, /--synthetic/);
  assert.match(build, /--forced-failure/);
});

test('native verifier requires capabilities, production tests, and measured probes', () => {
  const verifier = read('scripts/verify-native-bundle.js');
  assert.match(verifier, /--q3c-capabilities/);
  assert.match(verifier, /q3c-native-tests/);
  assert.match(verifier, /q3c-stabilization-probe/);
  assert.match(verifier, /smallMotionReductionPercent/);
  assert.match(verifier, /sustainedMotionReturnMs/);
  assert.match(verifier, /borderPixels/);
  assert.match(verifier, /peakQueueDepth/);
});

test('locked native profiles protect playback and codec option contracts', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /OPT_AUDIO_OUTPUT_BUFFER:[\s\S]{0,160}q3c_locked_option_seen = true/);
  assert.match(patch, /OPT_VIDEO_CODEC_OPTIONS:[\s\S]{0,160}q3c_locked_option_seen = true/);
  assert.match(patch, /!opts->window \|\| !opts->video \|\| !opts->video_playback/);
  assert.match(read('scripts/verify-native-bundle.js'), /invalidLockedProfileArguments/);
});

test('locked native profiles preserve headset playback without renderer-supplied audio flags', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(
    patch,
    /if \(opts->audio\) \{[\s\S]{0,160}opts->audio_source = SC_AUDIO_SOURCE_PLAYBACK;[\s\S]{0,100}opts->audio_dup = true/,
  );
});

test('locked native profiles cancel the canted-panel rotation', () => {
  // Quest 3's panels are physically canted, so the compositor writes a
  // pre-rotated image into the display buffer that scrcpy captures. Confirmed
  // on hardware: the captured buffer sits ~20 degrees counter-clockwise, and
  // scrcpy's --angle is clockwise-positive, so the correction is +20.
  //
  // The rotation costs no image, because addCrop and addAngle compose into one
  // affine transform sampling the full display texture -- rotation pulls in
  // real pixels from outside the crop rather than the shader's vec4(0.0), which
  // only appears if a sample leaves the display entirely.
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /const char \*presentation_angle/);
  assert.match(patch, /\.presentation_angle = "-22"/);
  assert.match(patch, /opts->angle = profile->presentation_angle/);
  assert.match(patch, /case OPT_ANGLE:[\s\S]{0,100}q3c_locked_option_seen = true/);
  assert.match(read('native/overlay/q3c-native-tests.c'), /presentation_angle, "-22"/);
});

test('the presentation correction follows which eye is cropped', () => {
  // Quest 3's two display panels are canted in opposite directions, so the
  // compositor pre-rotates each eye the opposite way. The correction therefore
  // depends on which eye a profile crops, NOT on the crop's aspect ratio:
  //
  //   left eye  -> +20   right eye -> -22
  //
  // All measured on hardware against the Quest menu, which is roll-locked to
  // gravity. Every profile except 1:1 left crops the right eye: Low Latency and
  // Stabilized both sit at x>=2064, as does the 1:1 right crop.
  const angleFor = (patch, crop) => {
    const profile = new RegExp(
      `\\.server_crop = "${crop}",\\s*\\n\\+\\s*\\.presentation_angle = "([^"]+)"`
    ).exec(read(patch));
    assert.ok(profile, `no profile found for crop ${crop}`);
    return profile[1];
  };
  const locked = 'native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch';
  const square = 'native/patches/0003-add-locked-square-eye-profiles.patch';
  assert.equal(angleFor(locked, '1792:1008:2200:600'), '-22', 'Low Latency crops the right eye');
  assert.equal(angleFor(locked, '2064:1160:2064:524'), '-22', 'Stabilized crops the right eye');
  assert.equal(angleFor(square, '1488:1488:288:360'), '20', '1:1 left crops the left eye');
  assert.equal(angleFor(square, '1488:1488:2352:360'), '-22', '1:1 right crops the right eye');
});

test('readiness is acknowledged only by rendered screen frames', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /q3c_stabilization_sink_ack_rendered/);
  assert.match(patch, /frame_rendered_callback/);
  assert.match(
    patch,
    /sc_screen_render\(screen, false\);[\s\S]{0,600}frame_rendered_callback/,
  );
  assert.match(patch, /corrected.video.width = 1920/);
  assert.match(patch, /corrected.video.height = 1080/);
  assert.match(patch, /q3c_direct_ready_ack_rendered/);
  assert.match(
    patch,
    /q3c_profile && q3c_profile->stabilized[\s\S]{0,500}q3c_stabilization_sink/,
  );
  assert.match(
    patch,
    /\+\s*\} else \{\r?\n\+\s*sc_frame_source_add_sink\(src, &s->screen\.frame_sink\)/,
  );
});

test('stabilization resets sessions and validates production frame contracts', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /q3c_stabilization_filter_reset/);
  assert.match(patch, /AV_PIX_FMT_YUV420P/);
  assert.match(patch, /AV_NOPTS_VALUE/);
  assert.match(patch, /last_input_pts/);
  assert.match(patch, /last_filter_output_pts/);
  assert.match(patch, /Q3C_NOMINAL_DELAY_US 100000/);
  assert.match(patch, /Q3C_MAXIMUM_DELAY_US 120000/);
  assert.match(patch, /q3c_delay_action_for_age/);
  assert.match(patch, /Q3C_DELAY_DROP_STALE/);
  assert.match(patch, /delay_queue/);
  assert.match(patch, /lavfi\.q3c\.transform_y/);
  assert.match(patch, /q3c_stabilization_frame_covers_final_crop/);
  assert.match(patch, /Stabilization transform exposes the calibrated/);
});

test('OpenCL contract requires a GPU and sanitizes its name as UTF-8', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /CL_DEVICE_TYPE_GPU/);
  assert.match(patch, /q3c_utf8_sanitize/);
});

test('synthetic probe measures a materially sustained production run', () => {
  const probe = read('native/overlay/q3c-stabilization-probe.c');
  assert.match(probe, /SUSTAINED_RUN_FRAMES 3600/);
  assert.match(probe, /submissionToOutputMs/);
  assert.match(probe, /memorySlopeBytesPerFrame/);
  assert.match(probe, /borderDepthsChecked/);
});

test('readiness publication is ordered before downstream push and serialized with close', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(
    patch,
    /pending_ready = true[\s\S]{0,500}sc_frame_source_sinks_push/,
  );
  assert.match(patch, /q3c_rollback_pending_ready/);
  assert.match(patch, /event_emitter\(event\)[\s\S]{0,120}sc_mutex_unlock/);
  assert.match(read('native/overlay/q3c-native-tests.c'), /synchronous_ack/);
  assert.match(read('native/overlay/q3c-native-tests.c'), /ack_after_close/);
});

test('screen reports render failure and suppresses the rendered callback', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /static bool\s+sc_screen_render/);
  assert.match(patch, /q3c_render_path_execute\(screen->render_ops/);
  assert.match(patch, /return clear_ok && texture_ok && present_ok/);
  assert.match(
    patch,
    /if \(!sc_screen_render\(screen, false\)\)[\s\S]{0,120}return false/,
  );
  assert.match(read('native/overlay/q3c-native-tests.c'), /render_failure_suppressed/);
});

test('screen queues immutable session metadata with every pending frame', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /pending_frame_session/);
  assert.match(patch, /consumed_frame_session/);
  assert.match(
    patch,
    /pending_frame_session = screen->current_session/,
  );
  assert.match(
    patch,
    /consumed_frame_session = screen->pending_frame_session/,
  );
  assert.match(
    patch,
    /consumed_frame_session = screen->resume_frame_session/,
  );
});

test('mirror detection uses coordinate identities and mandatory positive controls', () => {
  const probe = read('native/overlay/q3c-stabilization-probe.c');
  assert.match(probe, /coordinate_identity/);
  assert.match(probe, /inject_mirrored_border/);
  assert.match(probe, /mirror_positive_controls/);
  assert.match(probe, /mirror_negative_control/);
  assert.match(probe, /MIRROR_CONTROL_WIDTHS/);
});

test('native lifecycle executable opens and resets the production OpenCL sink', () => {
  const nativeTests = read('native/overlay/q3c-native-tests.c');
  assert.match(nativeTests, /test_stabilized_live_graph/);
  assert.match(nativeTests, /delayed_frames_disposed/);
  assert.match(nativeTests, /concurrent_ack_lifecycle/);
  assert.match(nativeTests, /q3c_stabilization_sink_open_for_test/);
});

test('OpenCL creation explicitly filters and deterministically selects a GPU', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /av_dict_set\(&device_options, "device_type", "gpu"/);
  assert.match(patch, /q3c_select_first_gpu/);
  assert.match(read('native/overlay/q3c-native-tests.c'), /cpu_first_gpu_second/);
});

test('paused stale frame events use a non-asserting guarded consume path', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /sc_frame_buffer_try_consume/);
  assert.match(
    patch,
    /if \(!sc_frame_buffer_try_consume\(&screen->fb, screen->resume_frame\)\)/,
  );
  assert.match(read('native/overlay/q3c-native-tests.c'), /paused_stale_event_safe/);
});

test('mirror controls cover all edges and variable-width corner wedges', () => {
  const probe = read('native/overlay/q3c-stabilization-probe.c');
  for (const edge of ['EDGE_LEFT', 'EDGE_RIGHT', 'EDGE_TOP', 'EDGE_BOTTOM']) {
    assert.match(probe, new RegExp(edge));
  }
  assert.match(probe, /inject_variable_width_wedge/);
  assert.match(probe, /row_varying_wedge/);
  assert.match(probe, /column_varying_wedge/);
  assert.match(probe, /mirrorPositiveControls/);
  assert.match(probe, /mirrorPositiveControls\\":%u/);
});

test('production render wrappers and lifecycle barriers exercise overlapping failures', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  assert.match(patch, /q3c_render_path_execute/);
  assert.match(patch, /screen->render_ops/);
  const nativeTests = read('native/overlay/q3c-native-tests.c');
  assert.match(nativeTests, /clear_failure_suppressed/);
  assert.match(nativeTests, /texture_failure_suppressed/);
  assert.match(nativeTests, /present_failure_suppressed/);
  assert.match(nativeTests, /publication_in_flight/);
  assert.match(nativeTests, /close_contending/);
});

test('close try-lock proves the exact stabilization sink mutex is busy', () => {
  const patch = read('native/patches/0002-add-locked-obs-profiles-and-opencl-stabilizer.patch');
  const nativeTests = read('native/overlay/q3c-native-tests.c');
  assert.match(patch, /SDL_TryLockMutex\(sink->mutex\.mutex\)/);
  assert.match(patch, /Q3C_CLOSE_TRY_MUTEX_BUSY/);
  assert.match(patch, /Q3C_CLOSE_AFTER_MUTEX/);
  assert.match(
    patch,
    /SDL_TryLockMutex\(sink->mutex\.mutex\)[\s\S]{0,500}Q3C_CLOSE_TRY_MUTEX_BUSY[\s\S]{0,300}sc_mutex_lock\(&sink->mutex\)[\s\S]{0,300}Q3C_CLOSE_AFTER_MUTEX/,
  );
  assert.match(nativeTests, /try_lock_busy/);
  assert.match(nativeTests, /close_after_mutex/);
  assert.match(nativeTests, /!barrier\.close_after_mutex/);
});
