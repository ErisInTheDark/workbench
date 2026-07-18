/*
 * Exports:
 * - No production exports; Node tests protect direct child-to-parent message heading identity styling. Keywords: thread, subagent, parent, message, heading, color.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getThreadAgentAccentColor } from "../../../lib/workbench/thread/thread-subagents";

import ThreadSubagentIncomingMessage from "./ThreadSubagentIncomingMessage";

test("styles the incoming subagent name with the shared agent accent", () => {
  const subagent = {
    activityStatus: "inactive" as const,
    createdAt: 1,
    cwd: "C:/workspace",
    directSubagentIndex: 2,
    harness: "codex" as const,
    lastActivityAt: 1,
    name: "Mimi",
    parentThreadId: "parent-thread",
    profileId: "profile",
    profileName: "Profile",
    projectId: "project",
    threadId: "child-thread",
    title: "Task",
    updatedAt: 1,
  };
  const html = renderToStaticMarkup(createElement(
    ThreadSubagentIncomingMessage,
    {
      children: createElement("p", null, "Parent-facing progress."),
      name: "Mimi",
      steerState: null,
      subagent,
    },
  ));

  assert.match(html, /<p class="m-0 text-\[0\.78em\] font-medium leading-\[1\.5\] text-muted">/u);
  assert.match(html, /<span class="font-medium"/u);
  assert.match(html, />Mimi<\/span><\/span> sent a message<\/p>/u);
  assert(html.includes(`style="color:${getThreadAgentAccentColor(subagent)}"`));
});
