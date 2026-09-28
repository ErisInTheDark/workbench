/*
 * Exports:
 * - default AppWorkspaceNode: own cross-daemon connections, queries, draft launch and presentation import.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";
import WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import WorkbenchWorkspaceController from "../workspace/WorkbenchWorkspaceController";
import WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import WorkbenchWorkspaceDrafts from "../workspace/WorkbenchWorkspaceDrafts";
import WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController";
import type { AppProcessContext } from "./app-process-context";
import type { AppRuntimeObjects } from "./app-runtime-objects";
import AppHttpNode from "./AppHttpNode";

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
  access: "operator",
  children: [AppHttpNode],
  create: (context, build) => {
    const presentation = build.get("presentation");
    const warn = (message: string) => build.get("logger").error("app", message);
    const sources = new WorkbenchDaemonSources({ network: build.get("network"), warn });
    const workspace = new WorkbenchWorkspaceController({ sources, presentation, warn });
    const workspaceThreads = new WorkbenchWorkspaceThreads({ sources, presentation, warn });
    const workspaceDrafts = new WorkbenchWorkspaceDrafts({
      sources, presentation, warn, origin: () => context.appPort.current?.()?.appOrigin ?? null,
    });
    const presentationImport = new WorkbenchPresentationImportController({
      sources, presentation, logger: build.get("logger"),
    });
    return {
      registrations: { sources, workspace, workspaceThreads, workspaceDrafts, presentationImport },
      start: () => {
        workspace.start();
        workspaceThreads.start();
        presentationImport.start();
        sources.start();
      },
      dispose: async () => {
        const importing = presentationImport.close();
        const launching = workspaceDrafts.dispose();
        workspaceThreads.dispose();
        workspace.dispose();
        // Retire transport before draining accepted work. Uncertain launches retain
        // their durable launch ID for the replacement owner to reconcile.
        sources.dispose();
        await Promise.all([importing, launching]);
      },
    };
  },
  description: "Reload app-owned daemon connections, workspace queries and semantic operations.",
  lifecycle: "atomic",
  provides: ["sources", "workspace", "workspaceThreads", "workspaceDrafts", "presentationImport"],
  requires: ["network", "presentation", "logger"],
  safeAll: false,
  scope: "client:workspace",
  sources: [
    "app/server/runtime/AppWorkspaceNode.ts", "app/server/workspace/**",
    "app/server/state/WorkbenchPresentationImportController.ts",
    "app/server/state/workbench-presentation-layout.ts",
    "shared/workbench/workspace/**", "shared/workbench/WorkbenchRpcSocketClient.ts",
    "shared/workbench/WorkbenchSocketClient.ts", "shared/workbench/daemon/**",
    "shared/workbench/project/workbench-project-projection.ts",
    "shared/workbench/provider/provider-observation.ts",
  ].join("\n"),
});
