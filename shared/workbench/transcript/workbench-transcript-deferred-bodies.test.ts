/*
 * No exports. Protect which settled tool bodies may leave delivery and that projection marks them for hydration.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptItemEnvelope,
  type WorkbenchTranscriptSnapshot,
} from "../database/transcript/workbench-transcript-contract.ts";
import { WORKBENCH_QUESTIONNAIRE_TOOL_NAME } from "../thread/thread-questionnaire-history.ts";
import { deferWorkbenchTranscriptEnvelopeBody } from "./workbench-transcript-deferred-bodies.ts";
import { composeWorkbenchTranscriptWindow, splitWorkbenchTranscriptSnapshot } from "./workbench-transcript-envelope.ts";
import { projectWorkbenchTranscript } from "./workbench-transcript-projection.ts";

type Callable = { kind: "dynamic"; tool: string } | { kind: "mcp"; server: string; tool: string };

function toolSnapshot(callable: Callable, state: "completed" | "failed" | "inProgress" = "completed"): WorkbenchTranscriptSnapshot {
  const rows = emptyTranscriptSnapshotRows();
  const publicId = "4d29f440-0770-471a-8c55-b672c8181cf0";
  rows.threadItems.push({
    created_at: 1, id: 1, item_position: 0, public_id: publicId, thread_id: "thread", turn_id: "turn", type: "operation", updated_at: 1,
  });
  rows.itemIdentities.push({ id: publicId, thread_id: "thread" });
  rows.threadItemOperations.push({ item_id: 1, item_type: "operation", source_kind: "tool", source_revision: 1 });
  rows.threadOperationToolSources.push({
    duration_ms: 5, item_id: 1, item_type: "operation", source_kind: "tool", source_revision: 1,
    state, tool_kind: "callable", tool_name: callable.tool,
  });
  rows.threadOperationCallableToolSources.push({
    app_action_name: null, app_connector_id: null, app_link_id: null, app_name: null, app_resource_uri: null,
    arguments_json: "{\"path\":\"a.ts\"}", callable_kind: callable.kind, error_text: null, item_id: 1,
    legacy_resource_uri: null, namespace: null, plugin_id: null, provider_metadata_json: null, read_only_hint: null,
    server_name: callable.kind === "mcp" ? callable.server : null, source_revision: 1, state,
    success: callable.kind === "dynamic" ? 1 : null, tool_call_group_id: null, tool_kind: "callable", tool_name: callable.tool,
  });
  if (callable.kind === "dynamic") {
    rows.threadCallableDynamicContent.push({
      callable_kind: "dynamic", content_index: 0, content_kind: "inputText", item_id: 1, source_revision: 1, text: "file body", url: null,
    });
  } else {
    rows.threadCallableMcpResults.push({
      callable_kind: "mcp", item_id: 1, meta_json: null, source_revision: 1, structured_content_json: "{\"exitCode\":0}",
    });
    rows.threadCallableMcpResultContent.push({
      content_index: 0, content_kind: "text", item_id: 1, opaque_json: null, source_revision: 1, text: "output",
    });
  }
  return {
    hasPreviousTurns: false,
    loadedTurnIds: ["turn"],
    rows,
    thread: {
      activity_at: 1, archived: 0, created_at: 1, id: "thread", identity_origin: "workbench", next_turn_index: 1, pinned: 0,
      project_id: "project", project_root: "C:/project", snoozed: 0, title: "Thread", transcript_content_version: 1, updated_at: 1,
    },
    turns: [{
      created_at: 1, duration_ms: 1, ended_at: 2, harness_id: "claude", id: "turn", identity_origin: "workbench",
      native_location: "C:/project", native_thread_id: "thread", native_turn_id: "turn", started_at: 1, state: "completed",
      thread_id: "thread", turn_index: 0,
    }],
  };
}

function envelope(snapshot: WorkbenchTranscriptSnapshot): WorkbenchTranscriptItemEnvelope {
  return splitWorkbenchTranscriptSnapshot(snapshot).envelopes[0]!;
}

function project(source: WorkbenchTranscriptSnapshot, item: WorkbenchTranscriptItemEnvelope) {
  const partition = splitWorkbenchTranscriptSnapshot(source);
  const projected = projectWorkbenchTranscript(composeWorkbenchTranscriptWindow(partition.catalog, [item], { hasPreviousItems: false }));
  assert.ok(projected.success, JSON.stringify("issues" in projected ? projected.issues : null));
  return projected.data.turns[0]!.items[0]!;
}

test("settled native tool output leaves delivery and projects as deferred until its complete rows return", () => {
  const source = toolSnapshot({ kind: "dynamic", tool: "Read" });
  const full = envelope(source);
  const deferred = deferWorkbenchTranscriptEnvelopeBody(full);
  assert.ok(deferred);
  assert.ok(deferred.retainedBytes < full.retainedBytes);
  const summary = project(source, deferred);
  assert.equal(summary.type, "dynamicToolCall");
  assert.ok(summary.type === "dynamicToolCall");
  assert.equal(summary.bodyDeferred, true);
  assert.equal(summary.contentItems, null);
  assert.deepEqual(summary.arguments, { path: "a.ts" }, "summaries keep their arguments");
  const hydrated = project(source, full);
  assert.ok(hydrated.type === "dynamicToolCall");
  assert.equal(hydrated.bodyDeferred, undefined);
  assert.deepEqual(hydrated.contentItems, [{ text: "file body", type: "inputText" }]);
});

test("bodies that collapsed summaries read stay eager", () => {
  assert.equal(deferWorkbenchTranscriptEnvelopeBody(envelope(toolSnapshot({ kind: "dynamic", tool: WORKBENCH_QUESTIONNAIRE_TOOL_NAME }))), null);
  assert.equal(deferWorkbenchTranscriptEnvelopeBody(envelope(toolSnapshot({ kind: "mcp", server: "wb", tool: "git_arc_status" }))), null);
  assert.equal(deferWorkbenchTranscriptEnvelopeBody(envelope(toolSnapshot({ kind: "dynamic", tool: "Read" }, "failed"))), null);
  assert.equal(deferWorkbenchTranscriptEnvelopeBody(envelope(toolSnapshot({ kind: "dynamic", tool: "Read" }, "inProgress"))), null);
});

test("generic and wb shell MCP output defers while structured results stay", () => {
  for (const callable of [{ kind: "mcp", server: "wb", tool: "shell" }, { kind: "mcp", server: "github", tool: "search" }] as const) {
    const source = toolSnapshot(callable);
    const deferred = deferWorkbenchTranscriptEnvelopeBody(envelope(source));
    assert.ok(deferred, callable.tool);
    const summary = project(source, deferred);
    assert.ok(summary.type === "mcpToolCall");
    assert.equal(summary.bodyDeferred, true);
    assert.deepEqual(summary.result?.content, []);
    assert.deepEqual(summary.result?.structuredContent, { exitCode: 0 });
  }
});
