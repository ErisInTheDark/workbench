/* No production exports. Protect disclosure navigation from the row's default overlay link. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadSidebarEntrySchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchContextMenuContext from "./WorkbenchContextMenuContext";

test("disclosure summaries leave navigation exclusively to the supplied action", () => {
  const entry = WorkbenchThreadSidebarEntrySchema.parse({
    entryKind: "thread", activityAt: 1, title: "working", identity: { harness: "codex", threadId: "owner" },
    lifecycle: { agent: { agentStatus: "completed", turnId: "turn" }, kind: "completed", reason: "agentCompleted", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
  });
  const props = {
    projectId: ProjectIdSchema.parse("project"), entry, href: "/thread", showTooltip: false,
    action: createElement("a", { href: "/open" }, "Open"),
  };
  const render = (presentation: "row" | "disclosure-summary") => renderToStaticMarkup(createElement(
    WorkbenchContextMenuContext.Provider,
    { value: { openContextMenu: () => {}, closeContextMenu: () => {}, refreshContextMenu: () => {} } },
    createElement(WorkbenchThreadListItem, { ...props, presentation }),
  ));
  assert.match(render("row"), /href="\/thread"/u);
  assert.doesNotMatch(render("disclosure-summary"), /href="\/thread"/u);
  assert.match(render("disclosure-summary"), /href="\/open"/u);
});
