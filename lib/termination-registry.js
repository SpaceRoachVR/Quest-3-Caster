'use strict';

const {
  createTerminatingChildCollection,
} = require('./terminating-children');

function createTerminationRegistry() {
  const leases = new Set();

  function createContextLease() {
    let disposed = false;
    let lease;
    const retainedChildren = createTerminatingChildCollection({
      onEmpty: () => {
        if (disposed) leases.delete(lease);
      },
    });
    function registerForLateCleanup() {
      if (disposed) leases.add(lease);
    }
    function releaseDisposedEmptyLease() {
      if (disposed && retainedChildren.canLaunchReplacement()) {
        leases.delete(lease);
      }
    }
    const collection = Object.freeze({
      canLaunchReplacement: () => retainedChildren.canLaunchReplacement(),
      retain(child) {
        registerForLateCleanup();
        retainedChildren.retain(child);
        releaseDisposedEmptyLease();
      },
      retryTermination() {
        registerForLateCleanup();
        retainedChildren.retryTermination();
        releaseDisposedEmptyLease();
      },
      snapshot: () => retainedChildren.snapshot(),
      async terminateAndWait(candidates, options) {
        registerForLateCleanup();
        const result = await retainedChildren.terminateAndWait(candidates, options);
        releaseDisposedEmptyLease();
        return result;
      },
    });
    lease = Object.freeze({
      collection,
      dispose() {
        if (disposed) return;
        disposed = true;
        collection.retryTermination();
        releaseDisposedEmptyLease();
      },
      isDisposed: () => disposed,
    });
    leases.add(lease);
    return lease;
  }

  function retryTermination() {
    for (const lease of leases) {
      lease.collection.retryTermination();
    }
  }

  function canLaunchReplacement() {
    for (const lease of leases) {
      if (!lease.collection.canLaunchReplacement()) return false;
    }
    return true;
  }

  async function terminateAndWait({ waitForExit }) {
    if (typeof waitForExit !== 'function') {
      throw new TypeError('waitForExit must be a function.');
    }
    const active = [...leases].filter(
      (lease) => !lease.collection.canLaunchReplacement(),
    );
    const results = await Promise.all(active.map((lease) => {
      lease.collection.retryTermination();
      return lease.collection.terminateAndWait(
        lease.collection.snapshot(),
        { waitForExit },
      );
    }));
    return Object.freeze({
      allExited: results.every((result) => result.allExited),
      results: Object.freeze(results),
    });
  }

  function registeredContextCount() {
    return leases.size;
  }

  return Object.freeze({
    canLaunchReplacement,
    createContextLease,
    registeredContextCount,
    retryTermination,
    terminateAndWait,
  });
}

module.exports = { createTerminationRegistry };
