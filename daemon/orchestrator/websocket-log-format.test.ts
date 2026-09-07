/*
 * Keywords: websocket, failure diagnostics, untrusted input, payload privacy.
 * No exports. Checks send diagnostics retain routing evidence without exposing message bodies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWebSocketSendFailure } from "./websocket-log-format";

test("send failures retain routing context without serialising notification bodies", () => {
  const hidden = "private composer and transcript text";
  const message = {
    method: "workbench/thread-state/updated",
    params: {
      updateKind: "projectThreadSummary",
      summary: { projectId: "project-one", unsettledThreads: [{ title: hidden }] },
      prompt: hidden,
    },
  };
  const line = formatWebSocketSendFailure(message, new Error("Identity lookup failed"));
  assert.ok(line.includes(message.method.slice("workbench/".length)));
  assert.ok(line.includes(message.params.updateKind));
  assert.ok(line.includes(message.params.summary.projectId));
  assert.ok(!line.includes(hidden));
});

test("send failure diagnostics bound untrusted fields and prevent injected log lines", () => {
  const line = formatWebSocketSendFailure({
    method: `event\nforged-line\u001b[31m${"a".repeat(10_000)}`,
    params: { projectId: `project\r\nforged-line${"b".repeat(10_000)}` },
  }, new Error(`failure\r\nforged-line${"c".repeat(10_000)}`));
  assert.ok(!line.includes("\n") && !line.includes("\r"));
  assert.ok(line.length < 2_000);
});
