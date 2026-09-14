/*
 * Exports:
 * - default WorkbenchInstructionsNode: mirror bundled instructions and consume retired files once through durable tombstones.
 */
import {
  ensureWorkbenchInstructionSourceFiles,
  readWorkbenchInstructionTombstones,
} from "./lib/workbench/instructions/instruction-source";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchInstructionTombstoneController from "./WorkbenchInstructionTombstoneController";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (_context, build) => {
    const tombstones = new WorkbenchInstructionTombstoneController({ database: build.get("database") });
    return {
      dispose: () => undefined,
      registrations: {},
      start: async () => {
        await ensureWorkbenchInstructionSourceFiles();
        await tombstones.consume(readWorkbenchInstructionTombstones());
      },
    };
  },
  description: "Mirror bundled Workbench instructions and consume new retirement tombstones.",
  lifecycle: "atomic",
  provides: [],
  requires: ["database"],
  safeAll: false,
  scope: "server:instructions",
  sources: [
    "instructions/**/*.md",
    "instructions/**/*.md.tombstone",
  ].join("\n"),
});
