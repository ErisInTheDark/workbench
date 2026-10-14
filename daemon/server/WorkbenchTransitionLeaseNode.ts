/*
 * Exports:
 * - default WorkbenchTransitionLeaseNode: reload the Git transition and thread-state lock manager while handing its live lock table to the next generation.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchInstallationUpdateNode from "./WorkbenchInstallationUpdateNode";
import WorkbenchThreadTransitionCoordinator, { type TransitionLeaseHandoff } from "./WorkbenchThreadTransitionCoordinator";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchCoreNode, WorkbenchInstallationUpdateNode],
  create: (_context, build) => {
    const leases = new WorkbenchThreadTransitionCoordinator({
      initialState: build.handoffState as TransitionLeaseHandoff | undefined,
    });
    // Dependants are replaced in the same transition; their in-flight leases release into the shared table when they finish.
    const detach = async () => leases.detachForReload();
    return {
      registrations: { threadTransitions: leases },
      beginHandoff: () => ({
        waitForIdle: async () => undefined,
        expire: () => undefined,
        detach,
        resume: () => undefined,
        commit: () => undefined,
      }),
      detachForReload: detach,
      dispose: () => undefined,
      start: async () => {},
    };
  },
  description: "Reload Git transition and thread-state lock rules without dropping held leases.",
  lifecycle: "handoff",
  provides: ["threadTransitions"],
  requires: [],
  safeAll: true,
  scope: "server:leases",
});
