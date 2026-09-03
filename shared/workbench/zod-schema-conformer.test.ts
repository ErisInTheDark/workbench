/*
 * No production exports. Node tests protect schema-guided repair from lossy whole-object fallback. Keywords: zod, schema, default, repair, conformance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { conformToZodSchema } from "./zod-schema-conformer.ts";

test("conformance preserves valid siblings and valid array entries", () => {
  const schema = z.object({
    nested: z.object({ count: z.number().int(), label: z.string() }).strict(),
    tags: z.array(z.string()),
    title: z.string(),
  }).strict();
  const conformed = conformToZodSchema(schema, {
    nested: { count: "old", label: "kept", stale: true },
    stale: true,
    tags: ["one", 2, "two"],
    title: "kept",
  }, {
    nested: { count: 0, label: "fallback" },
    tags: [],
    title: "fallback",
  });

  assert.deepEqual(conformed.data, {
    nested: { count: 0, label: "kept" },
    tags: ["one", "two"],
    title: "kept",
  });
  assert.deepEqual(conformed.repairedPaths, [
    ["nested", "count"],
    ["nested", "stale"],
    ["tags", 1],
    ["stale"],
  ]);
});

test("conformance selects a default union branch and still runs transforms", () => {
  const schema = z.discriminatedUnion("kind", [
    z.object({ count: z.number().int(), kind: z.literal("thread"), title: z.string() }).strict(),
    z.object({ kind: z.literal("draft"), prompt: z.string() }).strict(),
  ]).transform((value) => ({ ...value, conformed: true as const }));
  const conformed = conformToZodSchema(schema, {
    count: "old",
    kind: "thread",
    title: "kept",
  }, {
    count: 0,
    kind: "thread",
    title: "fallback",
  });

  assert.deepEqual(conformed.data, { conformed: true, count: 0, kind: "thread", title: "kept" });
  assert.deepEqual(conformed.repairedPaths, [["count"]]);
});

test("a cross-field failure falls back at its smallest schema node", () => {
  const rangeSchema = z.object({ high: z.number(), low: z.number() }).strict().superRefine((value, context) => {
    if (value.low <= value.high) return;
    context.addIssue({ code: "custom", message: "low must not exceed high" });
  });
  const schema = z.object({ range: rangeSchema, title: z.string() }).strict();
  const conformed = conformToZodSchema(schema, {
    range: { high: 2, low: 5 },
    title: "kept",
  }, {
    range: { high: 1, low: 0 },
    title: "fallback",
  });

  assert.deepEqual(conformed.data, { range: { high: 1, low: 0 }, title: "kept" });
  assert.deepEqual(conformed.repairedPaths, [["range"]]);
});

test("an invalid default is a programming error", () => {
  const schema = z.object({ count: z.number().int() }).strict();
  assert.throws(
    () => conformToZodSchema(schema, { count: "old" }, { count: "invalid" } as never),
    z.ZodError,
  );
});
