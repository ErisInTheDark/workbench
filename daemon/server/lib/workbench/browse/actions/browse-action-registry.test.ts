/*
 * Exports:
 * - No production exports; Node tests cover typed Browse action registry normalization.
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

test("keeps exact fill text, including an empty clear", () => {
  for (const value of ["", "  padded "]) {
    const normalized = normalizeWorkbenchBrowseAgentRequest({
      action: "fill",
      ref: "0-5",
      session: "research",
      threadId: "thread-1",
      value,
    });
    assert.equal(normalized.ok, true);
    if (!normalized.ok || normalized.command.action !== "fill") return;
    assert.equal(normalized.command.runtimeRequest.kind === "command" ? normalized.command.runtimeRequest.params.value : null, value);
  }
});

test("preserves scoped snapshots and batched pointer input", () => {
  const snapshot = normalizeWorkbenchBrowseAgentRequest({
    action: "snapshot",
    compact: true,
    ref: "0-12",
    session: "research",
    threadId: "thread-1",
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok || !("runtimeRequest" in snapshot.command)) return;
  assert.deepEqual(snapshot.command.runtimeRequest.kind === "command" ? snapshot.command.runtimeRequest.params : null, {
    compact: true,
    filter: undefined,
    maxDepth: undefined,
    target: "@0-12",
  });

  const scroll = normalizeWorkbenchBrowseAgentRequest({
    action: "mouseScroll",
    deltaX: 0,
    deltaY: -300,
    intervalMs: 16,
    park: true,
    repeat: 4,
    session: "research",
    threadId: "thread-1",
    x: 195,
    y: 500,
  });
  assert.equal(scroll.ok, true);
  if (!scroll.ok || !("runtimeRequest" in scroll.command)) return;
  assert.deepEqual(scroll.command.runtimeRequest.kind === "command" ? scroll.command.runtimeRequest.params : null, {
    deltaX: 0,
    deltaY: -300,
    intervalMs: 16,
    park: true,
    repeat: 4,
    returnXPath: false,
    x: 195,
    y: 500,
  });
});

test("normalizes performance and touch controls into driver-owned commands", () => {
  const cases = [
    {
      action: {
        action: "touchScroll" as const,
        deltaX: 0,
        deltaY: -600,
        fling: true,
        intervalMs: 20,
        repeat: 2,
        session: "research",
        speed: 1200,
        threadId: "thread-1",
        x: 200,
        y: 500,
      },
      command: "workbench.touchScroll",
    },
    {
      action: { action: "emulateDevice" as const, preset: "pixel-7" as const, session: "research", threadId: "thread-1" },
      command: "workbench.emulateDevice",
    },
    {
      action: { action: "emulateColorScheme" as const, scheme: "dark" as const, session: "research", threadId: "thread-1" },
      command: "workbench.emulateColorScheme",
    },
    {
      action: { action: "throttleCpu" as const, rate: 4, session: "research", threadId: "thread-1" },
      command: "workbench.throttleCpu",
    },
    {
      action: { action: "throttleNetwork" as const, preset: "slow-3g" as const, session: "research", threadId: "thread-1" },
      command: "workbench.throttleNetwork",
    },
    {
      action: { action: "initScript" as const, expression: "globalThis.ready = true", session: "research", threadId: "thread-1" },
      command: "workbench.initScript",
    },
    {
      action: { action: "trace" as const, operation: "start" as const, session: "research", threadId: "thread-1" },
      command: "workbench.trace",
    },
  ];

  for (const example of cases) {
    const normalized = normalizeWorkbenchBrowseAgentRequest(example.action);
    assert.equal(normalized.ok, true);
    if (!normalized.ok || !("runtimeRequest" in normalized.command) || normalized.command.runtimeRequest.kind !== "command") continue;
    assert.equal(normalized.command.runtimeRequest.command, example.command);
  }
  const unsupported = normalizeWorkbenchBrowseAgentRequest({
    action: "emulateColorScheme",
    scheme: "sepia" as "dark",
    session: "research",
    threadId: "thread-1",
  });
  assert.equal(unsupported.ok, false);
});
