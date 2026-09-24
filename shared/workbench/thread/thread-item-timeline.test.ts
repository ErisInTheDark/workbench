/*
 * No exports. Protect timeline alias precedence and grouped duration across indexed lookups.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findWorkbenchThreadItemTimelineEntry,
  getThreadItemTimelineDurationMs,
  type WorkbenchThreadItemTimelineEntry,
} from "./thread-item-timeline.ts";

const entry = (
  itemId: string,
  startedAt: number,
  completedAt: number,
  aliases: string[] = [],
): WorkbenchThreadItemTimelineEntry => ({
  aliases, completedAt, firstSeenAt: null, itemId, lastSeenAt: null, startedAt,
});

test("timeline aliases keep first-match lookup and all-match duration", () => {
  const first = entry("first", 10, 20, ["shared"]);
  const second = entry("second", 5, 40, ["shared", "other"]);
  const timeline = [first, second];
  assert.equal(findWorkbenchThreadItemTimelineEntry("shared", timeline), first);
  assert.equal(findWorkbenchThreadItemTimelineEntry("other", timeline), second);
  assert.equal(getThreadItemTimelineDurationMs(["shared"], timeline), 35);
  assert.equal(getThreadItemTimelineDurationMs(["first", "other"], timeline), 35);
  assert.equal(getThreadItemTimelineDurationMs(["absent"], timeline), null);

  const replacement = [entry("replacement", 30, 50, ["shared"])];
  assert.equal(findWorkbenchThreadItemTimelineEntry("shared", replacement), replacement[0]);
  assert.equal(getThreadItemTimelineDurationMs(["shared"], replacement), 20);
});

test("repeated item lookups do not rescan a long unchanged timeline", () => {
  let reads = 0;
  const entries = Array.from({ length: 100 }, (_, index) => entry(`item-${index}`, index, index + 1));
  const timeline = new Proxy(entries, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(findWorkbenchThreadItemTimelineEntry("item-99", timeline), entries[99]);
  }
  assert.ok(reads < 500, `unchanged timeline needed ${reads} item reads`);
});
