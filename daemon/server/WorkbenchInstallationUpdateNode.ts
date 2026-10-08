/*
 * Exports:
 * - default WorkbenchInstallationUpdateNode: reload running-checkout update observation, scheduling and leased pull requests.
 */
import path from "node:path";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { projectRoot } from "./lib/project-root";
import ReloadableNode from "./ReloadableNode";
import WorkbenchInstallationUpdateController from "./WorkbenchInstallationUpdateController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import { createWorktreeGitTransitions } from "./worktree-git-transitions";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent", children: [WorkbenchWebSocketNode], lifecycle: "atomic",
  scope: "server:update", safeAll: true,
  description: "Reload installation update prediction, observation and pull admission.",
  provides: ["installationUpdate"],
  requires: ["projectCatalog", "projectSnapshot", "daemonRequests", "reloadDirt"],
  create(context, { get, run }) {
    const catalog = get("projectCatalog");
    const snapshots = get("projectSnapshot");
    const dirt = get("reloadDirt");
    const projectId = async () => (await catalog.readCatalog()).data
      .find(project => path.relative(projectRoot, path.resolve(project.rootPath)) === "")?.id ?? null;
    const controller = new WorkbenchInstallationUpdateController({
      repoRoot: projectRoot, dataRoot: context.dataRootPath,
      transitions: createWorktreeGitTransitions(context.threadTransitions),
      projectId,
      observe: async changed => {
        const id = await projectId();
        if (!id) throw new Error("The running checkout is not catalogued.");
        return snapshots.observe(id, changed, error => console.warn(`[installation-update] Project observation failed: ${error}`));
      },
      warn: warning => console.warn(`[installation-update] ${warning}`),
    });
    const unregister = get("daemonRequests").registerInstallationUpdate({
      pull: () => run("installationUpdate", async update => {
        const result = await update.pull();
        await dirt.refresh();
        return result;
      }, "installation pull"),
      dismissFailure: () => run("installationUpdate", update => update.dismissFailure(), "installation failure dismissal"),
    });
    return {
      registrations: { installationUpdate: controller },
      start: () => controller.start(),
      dispose: async () => { unregister(); await controller.dispose(); },
    };
  },
});
