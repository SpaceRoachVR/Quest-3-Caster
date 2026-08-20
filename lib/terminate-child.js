'use strict';

// Best-effort child-process kill shared by every module that owns or tracks
// scrcpy/native children. Killing is fire-and-forget: callers that need to
// know the process actually exited wait on the child's own 'exit'/'close'
// event (see waitForProcessExit in lib/process-exit.js) rather than trusting
// this call's return value.
function terminateChild(child) {
  if (!child || child.killed === true || typeof child.kill !== 'function') return;
  try {
    child.kill();
  } catch (_error) {
    // Shutdown is best effort; callers retain authoritative state until a
    // later exit/close observation.
  }
}

module.exports = { terminateChild };
