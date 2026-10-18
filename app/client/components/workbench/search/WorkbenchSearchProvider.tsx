/*
 * Exports:
 * - default WorkbenchSearchProvider: own the app's workspace search controller over the tab's workspace queries.
 */
"use client";

import { useEffect, useMemo, type ReactNode } from "react";

import WorkbenchSearchController from "../../../workbench/search/WorkbenchSearchController";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { WorkbenchSearchContext } from "./workbench-search-context";

export default function WorkbenchSearchProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkbenchWorkspace();
  const controller = useMemo(() => new WorkbenchSearchController({
    observe: (request, publish) => {
      const query = workspace.observe({ kind: "search", request });
      const stop = query.subscribe(() => publish(query.getSnapshot()));
      publish(query.getSnapshot());
      return () => { stop(); query.release(); };
    },
  }), [workspace]);
  useEffect(() => () => { controller.dispose(); }, [controller]);
  return <WorkbenchSearchContext.Provider value={controller}>{children}</WorkbenchSearchContext.Provider>;
}
