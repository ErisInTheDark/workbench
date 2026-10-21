/*
 * No exports. Protect app-rebased delivered transcript windows: browsers receive one baseline, then only
 * incremental changes in their own coordinates, never daemon-global offsets or off-window history.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptPrefetchResult,
  type WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { composeWorkbenchTranscriptWindow } from "workbench-shared/workbench/transcript/workbench-transcript-envelope";
import {
  applyTranscriptLayoutPatch,
  applyTranscriptStructure,
  type TranscriptLayout,
  type TranscriptStructureUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import WorkbenchDeliveredTranscriptWindow from "./WorkbenchDeliveredTranscriptWindow";

const threadId = "thread";
const turnId = "turn";

function history(count: number): Required<Pick<WorkbenchTranscriptPrefetchResult, "envelopes">> & {
  catalog: WorkbenchTranscriptSnapshot;
} {
  const catalog: WorkbenchTranscriptSnapshot = {
    hasPreviousTurns: false,
    loadedTurnIds: [],
    rows: emptyTranscriptSnapshotRows(),
    thread: {
      activity_at: 1, archived: 0, created_at: 1, id: threadId, identity_origin: "workbench", next_turn_index: 1,
      pinned: 0, project_id: "project", project_root: "C:/project", snoozed: 0, title: threadId,
      transcript_content_version: 1, updated_at: 1,
    },
    turns: [{
      created_at: 1, duration_ms: null, ended_at: null, harness_id: "codex", id: turnId, identity_origin: "workbench",
      native_location: "C:/project", native_thread_id: threadId, native_turn_id: turnId, started_at: 1,
      state: "inProgress", thread_id: threadId, turn_index: 0,
    }],
  };
  const envelopes = Array.from({ length: count }, (_, index) => {
    const rows = emptyTranscriptSnapshotRows();
    rows.threadItems.push({
      created_at: index, id: index + 1, item_position: index, public_id: `item-${index}`,
      thread_id: threadId, turn_id: turnId, type: "assistantMessage", updated_at: index,
    });
    rows.itemIdentities.push({ id: `item-${index}`, thread_id: threadId });
    rows.threadItemAssistantMessages.push({
      item_id: index + 1, item_type: "assistantMessage", phase: "commentary", state: "completed", text: `message ${index}`,
    });
    const value = {
      cursor: { itemId: `item-${index}`, itemPosition: index, turnIndex: 0 },
      itemId: `item-${index}`,
      snapshot: { ...catalog, loadedTurnIds: [turnId], rows },
    };
    return { ...value, retainedBytes: JSON.stringify(value).length * 2 };
  });
  return { catalog, envelopes };
}

function page(source: ReturnType<typeof history>, from: number, to: number, hasMore: boolean): WorkbenchTranscriptPrefetchResult {
  const envelopes = source.envelopes.slice(from, to);
  return { catalog: source.catalog, envelopes, hasMore, retainedBytes: 0 };
}

function live(source: ReturnType<typeof history>, ...indexes: number[]) {
  return composeWorkbenchTranscriptWindow(source.catalog, indexes.map(index => source.envelopes[index]!), {
    hasPreviousItems: true,
  });
}

/** Folds published updates exactly as the browser projection controller does. */
class Browser {
  layout: TranscriptLayout | null = null;
  projection: WorkbenchTranscriptProjection | null = null;

  apply(update: TranscriptStructureUpdate | null) {
    if (!update) return;
    this.layout = applyTranscriptLayoutPatch(update.reset ? null : this.layout, update.layout);
    this.projection = applyTranscriptStructure(update.reset ? null : this.projection, update, this.layout);
  }

  get itemIds() {
    return this.projection?.display.orderedItems.map(item => item.itemId) ?? [];
  }

  item(id: string) {
    return this.projection?.turns.flatMap(turn => turn.items).find(item => item.id === id);
  }
}

test("live changes reach the browser incrementally without replaying or losing its delivered window", () => {
  const source = history(6);
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();

  const baseline = window.deliver(page(source, 3, 5, true));
  assert.equal(baseline?.reset, true);
  browser.apply(baseline);
  assert.deepEqual(browser.itemIds, ["item-3", "item-4"]);
  assert.equal(browser.projection?.hasPreviousTurns, true);
  const retained = browser.item("item-3");

  const appended = window.receive(live(source, 5), []);
  assert.equal(appended?.reset, false);
  assert.deepEqual(appended?.snapshot.rows.threadItems.map(item => item.public_id), ["item-5"]);
  browser.apply(appended);
  assert.deepEqual(browser.itemIds, ["item-3", "item-4", "item-5"]);
  assert.equal(browser.item("item-3"), retained, "untouched items keep their identity");

  assert.equal(window.receive(live(source, 0), []), null, "off-window history never crosses without demand");
  browser.apply(window.receive(live(source), ["item-0"]));
  assert.deepEqual(browser.itemIds, ["item-3", "item-4", "item-5"], "undelivered removals change nothing");

  const older = window.deliver(page(source, 1, 3, true));
  assert.deepEqual(older?.snapshot.rows.threadItems.map(item => item.public_id), ["item-1", "item-2"]);
  browser.apply(older);
  assert.deepEqual(browser.itemIds, ["item-1", "item-2", "item-3", "item-4", "item-5"]);
  assert.deepEqual(window.loadedTurnIds, [turnId]);

  assert.equal(window.receive(live(source, 0, 1, 2, 3, 4, 5), []), null,
    "a daemon baseline replaying delivered rows publishes nothing");
  const edited = live(source, 4);
  edited.rows.threadItemAssistantMessages[0] = { ...edited.rows.threadItemAssistantMessages[0]!, text: "edited" };
  const correction = window.receive(edited, []);
  assert.deepEqual(correction?.snapshot.rows.threadItems.map(item => item.public_id), ["item-4"]);
  browser.apply(correction);
  assert.deepEqual(browser.itemIds, ["item-1", "item-2", "item-3", "item-4", "item-5"]);

  browser.apply(window.receive(live(source), ["item-3"]));
  assert.deepEqual(browser.itemIds, ["item-1", "item-2", "item-4", "item-5"]);

  const exhausted = window.deliver(page(source, 0, 1, false));
  browser.apply(exhausted);
  assert.deepEqual(browser.itemIds, ["item-0", "item-1", "item-2", "item-4", "item-5"]);
  assert.equal(browser.projection?.hasPreviousTurns, false);
});

/** Turns item `index` into a completed native Read call with one output body row. */
function withReadTool(source: ReturnType<typeof history>, index: number) {
  const envelope = source.envelopes[index]!;
  const rows = emptyTranscriptSnapshotRows();
  const id = index + 1;
  rows.threadItems.push({ ...envelope.snapshot.rows.threadItems[0]!, type: "operation" });
  rows.itemIdentities.push(...envelope.snapshot.rows.itemIdentities);
  rows.threadItemOperations.push({ item_id: id, item_type: "operation", source_kind: "tool", source_revision: 1 });
  rows.threadOperationToolSources.push({
    duration_ms: 5, item_id: id, item_type: "operation", source_kind: "tool", source_revision: 1,
    state: "completed", tool_kind: "callable", tool_name: "Read",
  });
  rows.threadOperationCallableToolSources.push({
    app_action_name: null, app_connector_id: null, app_link_id: null, app_name: null, app_resource_uri: null,
    arguments_json: "{}", callable_kind: "dynamic", error_text: null, item_id: id, legacy_resource_uri: null,
    namespace: null, plugin_id: null, provider_metadata_json: null, read_only_hint: null, server_name: null,
    source_revision: 1, state: "completed", success: 1, tool_call_group_id: null, tool_kind: "callable", tool_name: "Read",
  });
  rows.threadCallableDynamicContent.push({
    callable_kind: "dynamic", content_index: 0, content_kind: "inputText", item_id: id, source_revision: 1, text: "file body", url: null,
  });
  source.envelopes[index] = { ...envelope, snapshot: { ...envelope.snapshot, rows } };
}

test("settled history tool bodies stay app-side until the browser asks for them", () => {
  const source = history(4);
  withReadTool(source, 0);
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();
  browser.apply(window.deliver(page(source, 2, 4, true)));
  const older = window.deliver(page(source, 0, 2, false));
  assert.deepEqual(older?.snapshot.deferredItemBodies, [{ itemId: 1 }]);
  assert.deepEqual(older?.snapshot.rows.threadCallableDynamicContent, []);
  browser.apply(older);
  const summary = browser.item("item-0");
  assert.ok(summary?.type === "dynamicToolCall");
  assert.equal(summary.bodyDeferred, true);

  const body = window.bodies(["item-0"]);
  assert.equal(body.rows.threadCallableDynamicContent[0]?.text, "file body");
  assert.throws(() => window.bodies(["item-1"]), /no deferred body/);

  const corrected = live(source, 0);
  corrected.rows.threadCallableDynamicContent[0] = { ...corrected.rows.threadCallableDynamicContent[0]!, text: "changed" };
  browser.apply(window.receive(corrected, []));
  const replaced = browser.item("item-0");
  assert.ok(replaced?.type === "dynamicToolCall");
  assert.equal(replaced.bodyDeferred, undefined, "live changes arrive complete");
  assert.throws(() => window.bodies(["item-0"]), /no deferred body/);
});

test("a thread without history takes its first live baseline as the browser baseline", () => {
  const source = history(2);
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();
  assert.equal(window.deliver({ catalog: null, envelopes: [], hasMore: false, retainedBytes: 0 }), null);
  const baseline = window.receive(live(source, 0, 1), []);
  assert.equal(baseline?.reset, true);
  browser.apply(baseline);
  assert.deepEqual(browser.itemIds, ["item-0", "item-1"]);
  assert.equal(browser.projection?.hasPreviousTurns, false);
});

/** `turnCount` turns of one item each, oldest first; the newest turn is live and still empty. */
function longHistory(turnCount: number) {
  const base = history(0);
  const turns = Array.from({ length: turnCount }, (_, index) => ({
    ...base.catalog.turns[0]!, id: `turn-${index}`, native_turn_id: `turn-${index}`, turn_index: index,
    state: index === turnCount - 1 ? "inProgress" as const : "completed" as const,
  }));
  const catalog = { ...base.catalog, turns };
  const envelopes = turns.slice(0, -1).map((turn, index) => {
    const rows = emptyTranscriptSnapshotRows();
    rows.threadItems.push({
      created_at: index, id: index + 1, item_position: 0, public_id: `item-${index}`,
      thread_id: threadId, turn_id: turn.id, type: "assistantMessage", updated_at: index,
    });
    rows.itemIdentities.push({ id: `item-${index}`, thread_id: threadId });
    rows.threadItemAssistantMessages.push({
      item_id: index + 1, item_type: "assistantMessage", phase: "commentary", state: "completed", text: `message ${index}`,
    });
    const value = {
      cursor: { itemId: `item-${index}`, itemPosition: 0, turnIndex: index },
      itemId: `item-${index}`,
      snapshot: { ...catalog, turns: [turn], loadedTurnIds: [turn.id], rows },
    };
    return { ...value, retainedBytes: JSON.stringify(value).length * 2 };
  });
  return { catalog, envelopes };
}

test("browsers receive turn rows only for loaded turns, the turn before them and the newest turn", () => {
  const source = longHistory(10);
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();
  const baseline = window.deliver(page(source, 6, 9, true));
  assert.deepEqual(baseline?.snapshot.turns.map(turn => turn.id), ["turn-5", "turn-6", "turn-7", "turn-8", "turn-9"]);
  browser.apply(baseline);
  assert.deepEqual(browser.itemIds, ["item-6", "item-7", "item-8"]);
  assert.equal(browser.projection?.turnHistory.find(entry => entry.loadState === "unloaded")?.turnId, "turn-5",
    "the older-turn anchor is the turn right before the window");

  const older = window.deliver(page(source, 3, 6, true));
  assert.deepEqual(older?.snapshot.turns.map(turn => turn.id), ["turn-2", "turn-3", "turn-4", "turn-5"]);
  browser.apply(older);
  assert.deepEqual(browser.itemIds, ["item-3", "item-4", "item-5", "item-6", "item-7", "item-8"]);
});

test("browsers receive source aliases only for provisional items, and project the same identity kinds", () => {
  const source = history(2);
  const alias = (itemId: string, sourceKind: "provisional" | "stable", id: number) => ({
    component_index: 0, component_kind: "item" as const, id, item_identity_id: itemId, reference: `${sourceKind}-${itemId}`,
    source_kind: sourceKind, thread_id: threadId, turn_id: turnId,
  });
  source.envelopes[0]!.snapshot.rows.itemSourceAliases.push(alias("item-0", "provisional", 1), alias("item-0", "stable", 2));
  source.envelopes[1]!.snapshot.rows.itemSourceAliases.push(alias("item-1", "provisional", 3), { ...alias("item-1", "provisional", 4), reference: "again" });
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();
  const baseline = window.deliver(page(source, 0, 2, false));
  assert.deepEqual(baseline?.snapshot.rows.itemSourceAliases.map(row => row.id), [3]);
  browser.apply(baseline);
  const identityKind = (id: string) => (browser.item(id) as { workbenchIdentityKind?: string } | undefined)?.workbenchIdentityKind;
  assert.equal(identityKind("item-0"), undefined);
  assert.equal(identityKind("item-1"), "provisional");
});

test("recovered older items reopen exhausted paging without crossing the delivered boundary", () => {
  const source = history(3);
  const window = new WorkbenchDeliveredTranscriptWindow();
  const browser = new Browser();
  browser.apply(window.deliver(page(source, 2, 3, false)));
  assert.equal(browser.projection?.hasPreviousTurns, false);

  const recovered = window.receive(live(source, 0, 1), []);
  browser.apply(recovered);
  assert.equal(browser.projection?.hasPreviousTurns, true);
  assert.deepEqual(browser.itemIds, ["item-2"]);
  assert.deepEqual(recovered?.snapshot.rows.threadItems, []);
  assert.equal(window.receive(live(source, 0, 1), []), null);

  browser.apply(window.deliver(page(source, 0, 2, false)));
  assert.deepEqual(browser.itemIds, ["item-0", "item-1", "item-2"]);
  assert.equal(browser.projection?.hasPreviousTurns, false);
  assert.equal(window.receive(live(source, 0, 1), []), null);
});
