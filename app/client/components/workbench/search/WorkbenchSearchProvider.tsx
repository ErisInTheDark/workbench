/*
 * Exports:
 * - default WorkbenchSearchProvider: own the app's workspace search controller and its thread summary batch over the tab's workspace queries.
 */
"use client";

import { useEffect, useMemo, type ReactNode } from "react";

import WorkbenchSearchController from "../../../workbench/search/WorkbenchSearchController";
import ThreadSummaryStore from "../../../workbench/thread/ThreadSummaryStore";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { WorkbenchSearchContext } from "./workbench-search-context";

export default function WorkbenchSearchProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkbenchWorkspace();
  const { controller, summaries } = useMemo(() => {
    // Search leases its own batch so results can wait for complete rows without touching the sidebar's leases.
    const summaries = new ThreadSummaryStore(workspace);
    return {
      summaries,
      controller: new WorkbenchSearchController({
        observe: (request, publish) => {
          const query = workspace.observe({ kind: "search", request });
          const stop = query.subscribe(() => publish(query.getSnapshot()));
          publish(query.getSnapshot());
          return () => { stop(); query.release(); };
        },
        summaries,
      }),
    };
  }, [workspace]);
  useEffect(() => () => {
    controller.dispose();
    summaries.dispose();
  }, [controller, summaries]);
  return <WorkbenchSearchContext.Provider value={controller}>{children}</WorkbenchSearchContext.Provider>;
}
