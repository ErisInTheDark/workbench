/*
 * Default export:
 * - AppStateNode: own typed app-state reads and mutations over the active database node, forgetting app-state for
 *   logical projects the presentation removed.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import { formatWorkbenchAppLogMessage } from "../workbench-app-log-format.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppCompilerNode from "./AppCompilerNode.ts";
import AppNetworkNode from "./AppNetworkNode.ts";
import AppHttpNode from "./AppHttpNode.ts";
import AppWorkspaceNode from "./AppWorkspaceNode.ts";

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
  access: "operator",
  children: [AppCompilerNode, AppNetworkNode, AppWorkspaceNode, AppHttpNode],
  create: (context, build) => {
    const logger = context.processLogger.withMessageFormatter(formatWorkbenchAppLogMessage);
    const state = new WorkbenchBrowserStateRegistry(build.get("database"), {
      onDiagnostic: (message) => logger.error("app", message),
      onDatabaseDiagnostic: (browserStateId, level, message) => {
        const domain = `browser:${browserStateId.slice(0, 8)}` as const;
        if (level === "warn") logger.error(domain, message.trimStart());
        else logger.line(domain, message.trimStart());
      },
    });
    const presentation = new WorkbenchPresentationController(build.get("presentationDatabase"));
    // App-state keyed to a logical project the presentation no longer has is unreachable; keep the stores in step.
    const forgetRemovedProjects = () => {
      void state.forgetLogicalProjects(new Set(presentation.readProjectIds())).catch((error: unknown) => {
        logger.error("app", `Removed project state cleanup failed: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
      });
    };
    let unsubscribe: (() => void) | null = null;
    return {
      dispose: async () => { unsubscribe?.(); presentation.close(); await state.close(); },
      registrations: { logger, state, presentation },
      start: () => {
        state.start();
        unsubscribe = presentation.subscribe(forgetRemovedProjects);
        forgetRemovedProjects();
      },
    };
  },
  description: "Reload typed app-state reads, projections, and mutations without replacing SQLite.",
  lifecycle: "atomic",
  provides: ["logger", "state", "presentation"],
  requires: ["database", "presentationDatabase"],
  safeAll: false,
  scope: "client:state",
});
