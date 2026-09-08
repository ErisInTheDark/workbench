/*
 * Keywords: transcript, canonical cache, provider compatibility, render invalidation.
 * No exports. Tests protect thread loading and turn reuse when provider item shapes change.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { ThreadPayload } from "workbench-shared/types";
import ThreadCanonicalLayer from "./ThreadCanonicalLayer";
import { getThreadItemRenderSignature } from "./thread-item-signature";

function thread(item: ThreadItem): ThreadPayload {
  const turn = (id: string, items: ThreadItem[]): Turn => ({
    id, items, itemsView: "full", status: "completed", error: null,
    startedAt: 1, completedAt: 2, durationMs: 1000,
  });
  return {
    id: "thread", harness: "codex", name: null, preview: "", createdAt: 1, updatedAt: 2,
    status: "idle", cwd: "/repo", source: "appServer", path: null, agentNickname: null, agentRole: null,
    model: null, reasoningEffort: null, serviceTier: null, agentPath: null, isDraft: false,
    tokenUsage: null, turnHistory: [],
    turns: [
      turn("unchanged", [{ id: "plan", type: "plan", text: "retained plan" }]),
      turn("affected", [item]),
    ],
  };
}

const sleep: ThreadItem = { id: "sleep", type: "sleep", durationMs: 1000 };
// A newer provider can supply a shape absent from the installed generated union.
const future = { id: "future", type: "futureProviderItem", detail: "private body" };

for (const fixture of [
  { name: "sleep", item: sleep, changes: [{ ...sleep, durationMs: 2000 }] },
  {
    name: "future provider item", item: future as unknown as ThreadItem,
    changes: [{ ...future, detail: "updated private body" } as unknown as ThreadItem],
  },
]) {
  test(`canonical rendering preserves ${fixture.name} and invalidates only changed turns`, (context) => {
    const warnings: unknown[][] = [];
    context.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    const layer = new ThreadCanonicalLayer({ normalizeCanonicalThread: (value) => value });
    let revision = 0;
    const render = (item: ThreadItem) => layer.render({ key: "thread", revision: ++revision, rawThread: thread(item) });
    const initial = render(fixture.item);
    assert.deepEqual(initial.turns[1]?.items, [fixture.item]);
    const repeated = render({ ...fixture.item });
    assert.equal(repeated.turns[0], initial.turns[0]);
    assert.equal(repeated.turns[1], initial.turns[1], "Equivalent content must preserve the cached turn");
    let previous = repeated;
    for (const changed of fixture.changes) {
      const updated = render(changed);
      assert.equal(updated.turns[0], initial.turns[0]);
      assert.notEqual(updated.turns[1], previous.turns[1]);
      assert.deepEqual(updated.turns[1]?.items, [changed]);
      previous = updated;
    }
    if (fixture.name === "future provider item") {
      assert.ok(warnings.length > 0);
      assert.ok(warnings.flat().every((value) => typeof value === "string"
        && !value.includes(future.detail) && !value.includes("updated private body")));
      const large = { ...future, detail: future.detail.repeat(2000) } as unknown as ThreadItem;
      assert.ok(getThreadItemRenderSignature(large).length < future.detail.length * 2000,
        "The fallback signature must not retain an unbounded provider body");
    } else {
      assert.equal(warnings.length, 0, "Supported provider items are not warning conditions");
    }
  });
}
