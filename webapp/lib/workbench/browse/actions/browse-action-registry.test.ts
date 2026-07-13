/*
 * Exports:
 * - No production exports; Node tests cover typed Browse action registry normalization. Keywords: browse, action, registry, test, timeout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeWorkbenchBrowseAgentRequest } from "./browse-action-registry.ts";

test("normalizes open into a direct runtime request with an open-sized deadline", () => {
  const normalized = normalizeWorkbenchBrowseAgentRequest({
    action: "open",
    mode: "headed",
    persistent: true,
    session: "research",
    threadId: "thread-1",
    url: "http://localhost:3000",
    wait: "domcontentloaded",
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok || normalized.command.action !== "open") return;
  assert.deepEqual(normalized.command.runtimeRequest, {
    kind: "open",
    mode: "headed",
    params: {
      timeoutMs: 60_000,
      url: "http://localhost:3000",
      waitUntil: "domcontentloaded",
    },
    persistent: true,
    session: "research",
    timeoutMs: 60_000,
  });
});

test("normalizes browser commands without losing selector or session ownership", () => {
  const normalized = normalizeWorkbenchBrowseAgentRequest({
    action: "get",
    ref: "0-12",
    session: "research",
    threadId: "thread-1",
    timeoutMs: 1_250,
    what: "text",
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok || normalized.command.action !== "get") return;
  assert.deepEqual(normalized.command.runtimeRequest, {
    command: "get",
    kind: "command",
    mode: null,
    params: { selector: "@0-12", what: "text" },
    persistent: false,
    session: "research",
    timeoutMs: 1_250,
  });
});

test("rejects unsupported remote and malformed session requests", () => {
  assert.deepEqual(normalizeWorkbenchBrowseAgentRequest({
    action: "snapshot",
    local: false,
    session: "research",
    threadId: "thread-1",
  }), {
    error: "Typed Workbench Browse requests only support local browser sessions.",
    ok: false,
  });
  assert.deepEqual(normalizeWorkbenchBrowseAgentRequest({
    action: "status",
    session: "bad session",
    threadId: "thread-1",
  }), {
    error: "Typed Browse status requires a named session.",
    ok: false,
  });
});
