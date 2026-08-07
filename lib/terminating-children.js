'use strict';

function hasAuthoritativelyExited(child) {
  return Boolean(child) && (
    (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function terminateChild(child) {
  if (!child || typeof child.kill !== 'function') return;
  try {
    child.kill();
  } catch (_error) {
    // Retention remains authoritative until a later exit/close observation.
  }
}

function createTerminatingChildCollection({ onEmpty = () => {} } = {}) {
  if (typeof onEmpty !== 'function') {
    throw new TypeError('onEmpty must be a function.');
  }
  const children = new Set();
  const listeners = new Map();

  function remove(child) {
    const observer = listeners.get(child);
    if (observer) {
      child.removeListener('exit', observer.exit);
      child.removeListener('close', observer.close);
      child.removeListener('error', observer.error);
      listeners.delete(child);
    }
    const removed = children.delete(child);
    if (removed && children.size === 0) onEmpty();
  }

  function retain(child) {
    if (!child || children.has(child)) return;
    if (hasAuthoritativelyExited(child)) return;
    const observer = {
      exit: () => remove(child),
      close: () => remove(child),
      error: () => {
        // An error is not an exit; keep ownership until exit/close.
      },
    };
    children.add(child);
    listeners.set(child, observer);
    child.once('exit', observer.exit);
    child.once('close', observer.close);
    child.on('error', observer.error);
  }

  async function terminateAndWait(
    candidates,
    { waitForExit } = {},
  ) {
    if (!Array.isArray(candidates) || typeof waitForExit !== 'function') {
      throw new TypeError('Termination candidates and waitForExit are required.');
    }
    const uniqueChildren = [...new Set(candidates.filter(Boolean))];
    for (const child of uniqueChildren) {
      retain(child);
      terminateChild(child);
    }
    const results = await Promise.all(
      uniqueChildren.map(async (child) => {
        if (hasAuthoritativelyExited(child)) {
          remove(child);
          return true;
        }
        const exited = await waitForExit(child);
        if (exited === true) remove(child);
        return exited === true;
      }),
    );
    return Object.freeze({
      allExited: results.every(Boolean),
      results: Object.freeze(results),
    });
  }

  function retryTermination() {
    for (const child of children) terminateChild(child);
  }

  function snapshot() {
    return [...children];
  }

  function canLaunchReplacement() {
    return children.size === 0;
  }

  return Object.freeze({
    canLaunchReplacement,
    retain,
    retryTermination,
    snapshot,
    terminateAndWait,
  });
}

module.exports = {
  createTerminatingChildCollection,
  hasAuthoritativelyExited,
};
