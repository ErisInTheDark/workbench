/* No production exports. Mounted tests protect that a parent row's subagent claims follow the listing as it changes. */
import "../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkbenchThreadListing } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchClientContext, { type WorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchSubagentClaims } from "./use-workbench-subagent-claims";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function listing(claimedPaths: string[]): WorkbenchThreadListing {
  return {
    archivedCount: 0, rows: [], status: { listed: true, loading: false, error: "" },
    members: {
      parent: {
        key: "parent", homeKey: null, logicalProjectId: null, hostname: "", rootPath: "", title: "Parent", activityAt: 1,
        location: { daemonId: "33333333-3333-4333-8333-333333333333", projectId: "project" },
        ref: { kind: "thread", identity: { harness: "claude", threadId: PARENT } },
        subagentClaims: claimedPaths.length
          ? [{ threadId: CHILD, parentThreadId: PARENT, name: "Mira", title: "Audit", directSubagentIndex: 0, claimedPaths }]
          : [],
      },
    },
  } as unknown as WorkbenchThreadListing;
}

/** The sidebar store's two channels: sidebar facts and the combined listing notify separately. */
function fakeSidebar() {
  let current = listing([]);
  const sidebarListeners = new Set<() => void>();
  const listingListeners = new Set<() => void>();
  return {
    store: {
      getProjectSnapshot: () => null,
      getListing: () => current,
      subscribe: (listener: () => void) => { sidebarListeners.add(listener); return () => sidebarListeners.delete(listener); },
      subscribeListing: (listener: () => void) => { listingListeners.add(listener); return () => listingListeners.delete(listener); },
    },
    publishListing(next: WorkbenchThreadListing) {
      current = next;
      for (const listener of [...listingListeners]) listener();
    },
  };
}

test("a parent's subagent claims update when the listing publishes new member claims", async () => {
  const sidebar = fakeSidebar();
  const client = { controls: null, mounted: { threadSidebar: sidebar.store } } as unknown as WorkbenchClientController;
  const seen: string[][] = [];
  function Probe() {
    const claims = useWorkbenchSubagentClaims(ProjectIdSchema.parse("project"), PARENT);
    seen.push(claims.flatMap(entry => [...entry.claimedPaths]));
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(WorkbenchClientContext.Provider, { value: client }, createElement(Probe))); });
    assert.deepEqual(seen.at(-1), []);
    await act(async () => { sidebar.publishListing(listing(["src/a.ts"])); });
    assert.deepEqual(seen.at(-1), ["src/a.ts"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
