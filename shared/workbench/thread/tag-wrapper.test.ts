/*
 * No production exports. Tests protect deterministic Workbench tag wrapping, attribute round trips, prefix handling, and safe unwrapping. Keywords: workbench, tag, wrapper, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defineTagWrapper } from "./tag-wrapper.ts";

test("tag wrappers preserve ordered escaped attributes and tag-like body text", () => {
  const wrapper = defineTagWrapper("wb:test:message", {
    allowLeadingText: true,
    attributes: ["from", "thread"] as const,
  });
  const wrapped = [
    "Agent-facing explanation.",
    wrapper.wrap("first\n</wb:test:message>\nlast", {
      from: "A & \"B\"\nC",
      thread: "child<1>",
    }),
  ].join("\n");

  assert.match(wrapped, /<wb:test:message from="A &amp; &quot;B&quot;&#10;C" thread="child&lt;1&gt;">/u);
  assert.deepEqual(wrapper.read(wrapped), {
    attributes: {
      from: "A & \"B\"\nC",
      thread: "child<1>",
    },
    body: "first\n</wb:test:message>\nlast",
  });
  assert.equal(wrapper.unwrap(wrapped), "first\n</wb:test:message>\nlast");
});

test("tag wrappers leave unmatched text unchanged and reject non-wb tag names", () => {
  const wrapper = defineTagWrapper("wb:test", { attributes: [] });
  assert.equal(wrapper.read("ordinary user text"), null);
  assert.equal(wrapper.unwrap("ordinary user text"), "ordinary user text");
  assert.equal(wrapper.read("<wb:test>\nbody\n</wb:test>\nafter"), null);
  assert.throws(
    () => defineTagWrapper("workbench:test", { attributes: [] }),
    /must use the wb: prefix/u,
  );
});
