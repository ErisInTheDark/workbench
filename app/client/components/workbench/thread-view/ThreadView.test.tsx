/*
 * No production exports. Protect visible failure and retained ownership for unavailable UUID routes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { ExplorerSnapshot } from "workbench-shared/types";
import WorkbenchClientProvider from "../WorkbenchClientProvider";
import type { WorkbenchClientController } from "../workbench-client-context";
import ThreadView from "./ThreadView";

test("an unresolved existing-thread route shows its failure and retained owner", () => {
  const props = {
    projectId: "",
    routeOwned: true,
    routeError: "The owning daemon is unavailable.",
    threadOwnerContent: <span>desktop /repo</span>,
    threadTarget: {
      kind: "provider",
      threadId: ThreadReferenceSchema.parse("4148c9ad-75b2-4a22-9732-6cb8bb82f414"),
    },
  } as ComponentProps<typeof ThreadView>;
  const html = renderToStaticMarkup(
    <WorkbenchClientProvider client={{
      controls: null, explorer: {} as ExplorerSnapshot, mounted: null,
    }}>
      <ThreadView {...props} />
    </WorkbenchClientProvider>,
  );
  assert.match(html, /The owning daemon is unavailable/u);
  assert.match(html, /desktop \/repo/u);
});

test("a retained thread document does not turn pending project ownership into a failure", () => {
  const client = {
    controls: null,
    explorer: {} as ExplorerSnapshot,
    mounted: {
      getThreadController: () => ({
        getSnapshot: () => ({
          status: "ready", error: null, document: {}, entry: null,
          gitArcProposals: {}, pendingQuestionnaire: null, rateLimits: null,
          subagents: [], relatedDocuments: {}, transcript: { status: "idle" },
        }),
        subscribe: () => () => undefined,
        acquire: () => () => undefined,
      }),
    },
  } as unknown as WorkbenchClientController;
  const props = {
    projectId: "", routeOwned: true,
    threadTarget: {
      kind: "provider", threadId: ThreadReferenceSchema.parse("4148c9ad-75b2-4a22-9732-6cb8bb82f414"),
    },
  } as ComponentProps<typeof ThreadView>;
  const html = renderToStaticMarkup(
    <WorkbenchClientProvider client={client}>
      <ThreadView {...props} />
    </WorkbenchClientProvider>,
  );
  assert.doesNotMatch(html, /role="alert"/u);
  assert.match(html, /role="status"/u);
});
