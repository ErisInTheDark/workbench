/*
 * Exports:
 * - default WorkbenchExecReaperNode: record the current executor's sandboxed command roots in the database and stop
 *   the ones an earlier executor generation left running (a hard-killed daemon never could).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import WorkbenchExecRootStore from "./database/exec/WorkbenchExecRootStore";
import WorkbenchExecReaper from "./exec/WorkbenchExecReaper";
import { logError } from "./process-helpers";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, { get }) => {
    const processes = get("codexTools").processes;
    const log = (message: string) => logError("exec-reaper", message.slice(0, 500));
    const root = path.join(context.dataRootPath, "daemon", "exec");
    const reaper = processes ? new WorkbenchExecReaper({
      executor: processes.executor,
      store: new WorkbenchExecRootStore(get("database")),
      runSandboxed: processes.runSandboxed,
      root,
      log,
    }) : null;
    return {
      registrations: {},
      afterCommit: () => {
        if (!reaper) return;
        void mkdir(root, { recursive: true }).then(() => reaper.start())
          .catch(error => log(`Reaping leftover commands failed: ${error instanceof Error ? error.message : String(error)}`));
      },
      start: () => undefined,
      dispose: () => { reaper?.dispose(); },
    };
  },
  description: "Reload command-root tracking and reap commands an earlier executor left running.",
  lifecycle: "atomic",
  provides: [],
  requires: ["database", "codexTools"],
  safeAll: true,
  scope: "server:exec-reaper",
});
