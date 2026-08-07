'use strict';

function waitForProcessExit(child, {
  timeoutMs = 1500,
  scheduler = global,
} = {}) {
  const hasExited = child && (
    (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
  );
  if (!child || hasExited || typeof child.once !== 'function') {
    return Promise.resolve(true);
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 10000
    || !scheduler
    || typeof scheduler.setTimeout !== 'function'
    || typeof scheduler.clearTimeout !== 'function'
  ) {
    return Promise.reject(new Error('Process-exit wait options are invalid.'));
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const errorListener = () => {
      // A child-process error reports an operation failure, not process death.
    };
    const exitListener = () => finish(true);
    const closeListener = () => finish(true);
    const cleanup = () => {
      scheduler.clearTimeout(timer);
      child.removeListener('exit', exitListener);
      child.removeListener('close', closeListener);
      child.removeListener('error', errorListener);
    };
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exited);
    };
    child.once('exit', exitListener);
    child.once('close', closeListener);
    child.on('error', errorListener);
    timer = scheduler.setTimeout(() => finish(false), timeoutMs);
  });
}

module.exports = { waitForProcessExit };
