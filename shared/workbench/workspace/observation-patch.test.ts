/* No exports. Protect keyed observation deltas: exact round trips, minimal size, validation and log-safe summaries. */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  applyObservationDelta, describeObservationDelta, diffObservationValue, observationShape, type ObservationShape,
} from "./observation-patch";

const Row = z.object({ id: z.string(), title: z.string(), activityAt: z.number(), tags: z.array(z.string()).optional() }).strict();
type Row = z.infer<typeof Row>;
const Project = z.object({ projectId: z.string(), phase: z.string(), rows: z.array(Row) }).strict();
const Value = z.object({
  phase: z.string(), projects: z.array(Project), summaries: z.record(z.string(), z.object({ count: z.number() }).strict()),
}).strict();
type Value = z.infer<typeof Value>;
const shape: ObservationShape = {
  schema: Value,
  fields: {
    projects: observationShape.keyed((project: z.infer<typeof Project>) => project.projectId, Project, {
      schema: Project, fields: { rows: observationShape.keyed((row: Row) => row.id, Row) },
    }),
    summaries: observationShape.record(z.object({ count: z.number() }).strict()),
  },
};
const rows = (count: number) => Array.from({ length: count }, (_, index): Row => ({
  id: `codex:${String(index).padStart(8, "0")}-thread`, title: `Thread ${index} with a long enough title`, activityAt: index,
}));
const value = (projectRows: Row[]): Value => ({
  phase: "current", projects: [{ projectId: "p1", phase: "current", rows: projectRows }], summaries: { p1: { count: 1 } },
});

test("applying a delta reproduces the next value across adds, removals, reorders, nested and record changes", () => {
  const before = value(rows(6));
  const [a, b, c, d, e, f] = before.projects[0]!.rows as [Row, Row, Row, Row, Row, Row];
  const after: Value = {
    phase: "stale",
    projects: [
      { projectId: "p2", phase: "pending", rows: [] },
      { projectId: "p1", phase: "current", rows: [f, { ...c, title: "renamed", tags: ["x"] }, a, { id: "new", title: "n", activityAt: 9 }, e] },
    ],
    summaries: { p2: { count: 0 } },
  };
  void b; void d;
  const delta = diffObservationValue(before, after, shape);
  assert.ok(delta);
  assert.deepEqual(applyObservationDelta(before, delta, shape), after);
  assert.equal(diffObservationValue(after, structuredClone(after), shape), null);
});

test("one changed field in a 1,000-row collection costs one small field update", () => {
  const before = value(rows(1_000));
  const changed = before.projects[0]!.rows.map((row, index) => index === 500 ? { ...row, activityAt: 9_999 } : row);
  const after: Value = { ...before, projects: [{ ...before.projects[0]!, rows: changed }] };
  const delta = diffObservationValue(before, after, shape)!;
  assert.ok(JSON.stringify(delta).length < 200, JSON.stringify(delta));
  assert.deepEqual(applyObservationDelta(before, delta, shape), after);
  // Reordering one row to the front is one move, not a resend of the order.
  const reordered: Value = { ...before, projects: [{ ...before.projects[0]!, rows: [changed[500]!, ...changed.filter((_, index) => index !== 500)] }] };
  const moved = diffObservationValue(before, reordered, shape)!;
  assert.ok(JSON.stringify(moved).length < 300, JSON.stringify(moved));
  assert.deepEqual(applyObservationDelta(before, moved, shape), reordered);
});

test("a bookkeeping counter alone produces no delta but rides along with a real change", () => {
  const Counted = z.object({ revision: z.number(), title: z.string() }).strict();
  const countedShape: ObservationShape = { schema: Counted, incidental: ["revision"] };
  assert.equal(diffObservationValue({ revision: 1, title: "a" }, { revision: 2, title: "a" }, countedShape), null);
  const delta = diffObservationValue({ revision: 1, title: "a" }, { revision: 3, title: "b" }, countedShape)!;
  assert.deepEqual(applyObservationDelta({ revision: 1, title: "a" }, delta, countedShape), { revision: 3, title: "b" });
});

test("objects validated as a whole apply keyed changes and reject invalid results", () => {
  const Catalogue = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() }).strict()), rootPath: z.string() })
    .strict().transform(value => value);
  const shape: ObservationShape = { fields: { catalogue: observationShape.object({
    validate: Catalogue, fields: { data: observationShape.keyed((item: { id: string }) => item.id, z.object({ id: z.string(), name: z.string() }).strict()) },
  }) } };
  const before = { catalogue: { data: [{ id: "a", name: "A" }, { id: "b", name: "B" }], rootPath: "/" } };
  const after = { catalogue: { data: [{ id: "a", name: "A" }, { id: "b", name: "renamed" }], rootPath: "/" } };
  const delta = diffObservationValue(before, after, shape)!;
  assert.ok(JSON.stringify(delta).length < 120);
  assert.deepEqual(applyObservationDelta(before, delta, shape), after);
  assert.throws(() => applyObservationDelta(before, { objects: { catalogue: { set: { rootPath: 7 } } } }, shape), /invalid item/u);
});

test("deltas that set invalid items or unknown fields are rejected", () => {
  const before = value(rows(2));
  assert.throws(() => applyObservationDelta(before, { set: { surprise: 1 } }, shape), /unknown field/);
  assert.throws(() => applyObservationDelta(before, { collections: { projects: { update: [{ key: "p1", delta: {
    collections: { rows: { add: [{ key: "x", item: { id: "x", title: 3, activityAt: 1 } }] } },
  } }] } } }, shape), /invalid item/);
  assert.throws(() => applyObservationDelta(before, { collections: { projects: { remove: ["missing"] } } }, shape), /missing/);
});

test("summaries name collections, keys and changed fields without values", () => {
  const before = value(rows(3));
  const after: Value = { ...before, projects: [{ ...before.projects[0]!,
    rows: before.projects[0]!.rows.map((row, index) => index === 1 ? { ...row, title: "secret title", activityAt: 5 } : row) }] };
  const line = describeObservationDelta(diffObservationValue(before, after, shape)!);
  assert.match(line, /projects \+0 ~1 -0/);
  assert.match(line, /rows \+0 ~1 -0/);
  assert.match(line, /00000001/);
  assert.match(line, /title,activityAt/);
  assert.doesNotMatch(line, /secret/);
});
