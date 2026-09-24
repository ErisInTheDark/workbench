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
