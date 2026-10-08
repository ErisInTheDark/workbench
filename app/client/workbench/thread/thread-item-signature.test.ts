/*
 * No exports. Tests protect render-chunk reuse when provider item shapes change.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getThreadItemRenderSignature, getThreadItemsRenderChunkSignature } from "./thread-item-signature";

const sleep: ThreadItem = { id: "sleep", type: "sleep", durationMs: 1000 };
// A newer provider can supply a shape absent from the installed generated union.
const future = { id: "future", type: "futureProviderItem", detail: "private body" };

for (const fixture of [
  { name: "sleep", item: sleep, changed: { ...sleep, durationMs: 2000 } },
  {
    name: "future provider item", item: future as unknown as ThreadItem,
    changed: { ...future, detail: "updated private body" } as unknown as ThreadItem,
  },
]) {
  test(`render signatures keep equivalent ${fixture.name} chunks and invalidate changed ones`, (context) => {
    const warnings: unknown[][] = [];
    context.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    const signature = getThreadItemsRenderChunkSignature([fixture.item]);
    assert.equal(getThreadItemsRenderChunkSignature([{ ...fixture.item }]), signature, "Equivalent content must reuse the chunk");
    assert.notEqual(getThreadItemsRenderChunkSignature([fixture.changed]), signature);
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
