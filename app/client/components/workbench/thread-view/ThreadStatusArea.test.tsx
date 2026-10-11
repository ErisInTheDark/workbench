/* No production exports. Protect addressed feedback remaining available throughout a thread's lifecycle. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ExplorerSnapshot } from "workbench-shared/types";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchClientContext from "../workbench-client-context";
import ThreadStatusArea from "./ThreadStatusArea";

const feedback = [{
  kind: "feedback" as const,
  id: 7,
  daemonId: "daemon-a",
  category: "bug" as const,
  title: "Stats action fails",
  author: "model",
  thread: "source thread",
  createdAt: 1,
  report: "The stats action fails.",
}];

function render(lifecycle: WorkbenchThreadLifecycle) {
  return renderToStaticMarkup(createElement(WorkbenchClientContext.Provider, {
    value: { controls: null, explorer: {} as ExplorerSnapshot, mounted: null },
  }, createElement(ThreadStatusArea, {
    addressedFeedback: feedback,
    gitArc: null,
    harness: "codex",
    live: null,
    onFeedbackDeleted: async () => {},
    onOpenThread: () => {},
    skills: null,
    threadId: "thread",
    threadLifecycle: lifecycle,
    todos: { count: 0, goalSet: false, renderPanel: () => null },
    vis: null,
  })));
}

test("working and completed threads both expose their addressed feedback count", () => {
  const working = render({
    agent: { agentStatus: "working" },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  });
  const completed = render({ kind: "completed", reason: "providerInactive", settled: false });
  assert.match(working, />1<\/span>/u);
  assert.match(completed, />1<\/span>/u);
});
