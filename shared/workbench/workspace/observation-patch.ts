/*
 * Exports:
 * - ObservationDeltaSchema/ObservationDelta: nested field and keyed-collection changes between two revisions of one value.
 * - ObservationShape/ObservationShapeNode: declare an observation's validated fields, nested objects, records and keyed collections.
 * - observationShape: helpers that build shape nodes (`object`, `record`, `keyed`).
 * - diffObservationValue: smallest structured delta from one value to the next; null when nothing changed.
 * - applyObservationDelta: apply a delta, validating every touched field and item; throws on invalid deltas.
 * - describeObservationDelta: bounded log summary naming collections, keys and changed fields, never values.
 * - measureObservationDelta: count changed items so senders can name oversized updates.
 */
import { z } from "zod";
import { areDeeplyEqual } from "../deep-equality";

type Fields = Record<string, unknown>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** Field-level changes for one object; nested objects, records and keyed collections recurse. */
export type ObservationDelta = {
  set?: Record<string, JsonValue> | undefined;
  unset?: string[] | undefined;
  objects?: Record<string, ObservationDelta> | undefined;
  collections?: Record<string, KeyedDelta> | undefined;
};
type KeyedDelta = {
  add?: Array<{ key: string; item?: JsonValue }> | undefined;
  update?: Array<{ key: string; delta: ObservationDelta }> | undefined;
  remove?: string[] | undefined;
  /** Applied after add/update/remove, left to right: place `key` directly after `after` (null = first). */
  move?: Array<{ key: string; after?: string | null }> | undefined;
};

const key = z.string().min(1).max(1_024);
export const ObservationDeltaSchema: z.ZodType<ObservationDelta> = z.lazy(() => z.object({
  set: z.record(z.string().min(1).max(256), z.json()).optional(),
  unset: z.array(z.string().min(1).max(256)).optional(),
  objects: z.record(z.string().min(1).max(256), ObservationDeltaSchema).optional(),
  collections: z.record(z.string().min(1).max(256), KeyedDeltaSchema).optional(),
}).strict());
const KeyedDeltaSchema: z.ZodType<KeyedDelta> = z.lazy(() => z.object({
  add: z.array(z.object({ key, item: z.json() }).strict()).optional(),
  update: z.array(z.object({ key, delta: ObservationDeltaSchema }).strict()).optional(),
  remove: z.array(key).optional(),
  move: z.array(z.object({ key, after: key.nullable() }).strict()).optional(),
}).strict());

/**
 * Describes how a value decomposes. Fields not named in `fields` are compared whole.
 * `schema` validates individually set fields (it must be a plain object schema).
 */
export type ObservationShape = {
  schema?: z.ZodObject;
  /** Validates the whole object after a delta applies, for schemas that are not plain objects (e.g. transforms). */
  validate?: z.ZodType;
  fields?: Record<string, ObservationShapeNode>;
  /**
   * Bookkeeping fields (e.g. revision counters) that change without observable effect: they ride along
   * only when another field of the same object changed, so a counter bump alone publishes nothing.
   */
  incidental?: readonly string[];
};
export type ObservationShapeNode =
  | { kind: "object"; shape: ObservationShape }
  | { kind: "record"; value: z.ZodType; shape?: ObservationShape }
  | { kind: "keyed"; key: (item: never) => string; item: z.ZodType; shape?: ObservationShape };

export const observationShape = {
  object: (shape: ObservationShape): ObservationShapeNode => ({ kind: "object", shape }),
  /** `shape` decomposes each record value (e.g. keyed lists inside it); values are still validated whole. */
  record: (value: z.ZodType, shape?: ObservationShape): ObservationShapeNode => ({ kind: "record", value, shape }),
  keyed: <Item>(itemKey: (item: Item) => string, item: z.ZodType, shape?: ObservationShape): ObservationShapeNode => ({
    kind: "keyed", key: itemKey as (item: never) => string, item, shape,
  }),
};

const isFields = (value: unknown): value is Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const present = (record: Fields, field: string) => record[field] !== undefined;
const empty = (delta: ObservationDelta) => !delta.set && !delta.unset && !delta.objects && !delta.collections;
const json = (value: unknown) => value as JsonValue;

export function diffObservationValue(previous: object, next: object, shape: ObservationShape = {}): ObservationDelta | null {
  if (previous === next) return null;
  const delta = diffFields(previous as Fields, next as Fields, shape);
  return empty(delta) ? null : delta;
}

function diffFields(previous: Fields, next: Fields, shape: ObservationShape): ObservationDelta {
  const incidental = new Set(shape.incidental ?? []);
  const delta = diffSelectedFields(previous, next, shape, field => !incidental.has(field));
  if (!incidental.size || empty(delta)) return delta;
  const extra = diffSelectedFields(previous, next, shape, field => incidental.has(field));
  return {
    ...delta,
    ...(extra.set || delta.set ? { set: { ...delta.set, ...extra.set } } : {}),
    ...(extra.unset || delta.unset ? { unset: [...delta.unset ?? [], ...extra.unset ?? []] } : {}),
  };
}

function diffSelectedFields(previous: Fields, next: Fields, shape: ObservationShape, include: (field: string) => boolean): ObservationDelta {
  const delta: ObservationDelta = {};
  for (const field of Object.keys(previous)) {
    if (include(field) && present(previous, field) && !present(next, field)) (delta.unset ??= []).push(field);
  }
  for (const field of Object.keys(next)) {
    if (!include(field) || !present(next, field)) continue;
    const before = previous[field];
    const after = next[field];
    if (before === after) continue;
    const node = shape.fields?.[field];
    if (node && isFields(before) && isFields(after) && (node.kind === "object" || node.kind === "record")) {
      const nested = node.kind === "object" ? diffFields(before, after, node.shape) : diffFields(before, after, recordShape(node, after));
      if (!empty(nested)) (delta.objects ??= {})[field] = nested;
      continue;
    }
    if (node?.kind === "keyed" && Array.isArray(before) && Array.isArray(after)) {
      const keyed = diffKeyed(before, after, node);
      // Duplicate keys cannot be patched by key; such a list is replaced whole rather than failing the publish.
      if (keyed === "replace") (delta.set ??= {})[field] = json(after);
      else if (keyed) (delta.collections ??= {})[field] = keyed;
      continue;
    }
    if (!areDeeplyEqual(before, after)) (delta.set ??= {})[field] = json(after);
  }
  return delta;
}

/** Every record key decomposes with the record's value shape. */
function recordShape(node: Extract<ObservationShapeNode, { kind: "record" }>, record: Fields): ObservationShape {
  if (!node.shape) return {};
  const shape = node.shape;
  return { fields: Object.fromEntries(Object.keys(record).map(key => [key, { kind: "object" as const, shape }])) };
}

function diffKeyed(previous: readonly unknown[], next: readonly unknown[], node: Extract<ObservationShapeNode, { kind: "keyed" }>): KeyedDelta | null | "replace" {
  const keyOf = node.key as (item: unknown) => string;
  const before = new Map(previous.map(item => [keyOf(item), item]));
  const nextKeys = next.map(keyOf);
  if (new Set(nextKeys).size !== nextKeys.length || before.size !== previous.length) return "replace";
  const delta: KeyedDelta = {};
  const nextSet = new Set(nextKeys);
  for (const itemKey of before.keys()) if (!nextSet.has(itemKey)) (delta.remove ??= []).push(itemKey);
  for (const [index, item] of next.entries()) {
    const itemKey = nextKeys[index]!;
    const prior = before.get(itemKey);
    if (prior === undefined) { (delta.add ??= []).push({ key: itemKey, item: json(item) }); continue; }
    if (prior === item) continue;
    if (!isFields(prior) || !isFields(item)) {
      if (!areDeeplyEqual(prior, item)) {
        (delta.remove ??= []).push(itemKey);
        (delta.add ??= []).push({ key: itemKey, item: json(item) });
      }
      continue;
    }
    const itemDelta = diffFields(prior, item, node.shape ?? {});
    if (!empty(itemDelta)) (delta.update ??= []).push({ key: itemKey, delta: itemDelta });
  }
  const move = orderMoves(
    [...previous.map(keyOf).filter(itemKey => nextSet.has(itemKey) && !delta.add?.some(added => added.key === itemKey)),
      ...(delta.add ?? []).map(added => added.key)],
    nextKeys,
  );
  if (move.length) delta.move = move;
  return delta.add || delta.update || delta.remove || delta.move ? delta : null;
}

/** Minimal moves turning `base` into `target` (same key set): keep the longest increasing run in place. */
function orderMoves(base: readonly string[], target: readonly string[]) {
  const position = new Map(base.map((itemKey, index) => [itemKey, index]));
  const sequence = target.map(itemKey => position.get(itemKey)!);
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const parent = new Array<number>(sequence.length).fill(-1);
  for (const [index, value] of sequence.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailIndex[low] = index;
    parent[index] = low > 0 ? tailIndex[low - 1]! : -1;
  }
  const stable = new Set<number>();
  for (let index = tailIndex[tails.length - 1] ?? -1; index >= 0; index = parent[index]!) stable.add(index);
  return target.flatMap((itemKey, index) => stable.has(index) ? [] : [{ key: itemKey, after: target[index - 1] ?? null }]);
}

export function applyObservationDelta<Value extends object>(value: Value, delta: ObservationDelta, shape: ObservationShape = {}): Value {
  return applyFields(value as Fields, delta, shape, "value") as Value;
}

function validateField(shape: ObservationShape, field: string, value: unknown, path: string) {
  if (!shape.schema) return value;
  const fieldSchema = shape.schema.shape[field];
  if (!fieldSchema) throw new Error(`Observation delta sets unknown field ${path}.${field}.`);
  const parsed = fieldSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Observation delta set an invalid ${path}.${field}.`);
  return parsed.data;
}

function applyFields(target: Fields, delta: ObservationDelta, shape: ObservationShape, path: string): Fields {
  const next: Fields = { ...target };
  for (const field of delta.unset ?? []) {
    if (shape.schema && !shape.schema.shape[field]) throw new Error(`Observation delta unsets unknown field ${path}.${field}.`);
    delete next[field];
  }
  for (const [field, value] of Object.entries(delta.set ?? {})) {
    const node = shape.fields?.[field];
    next[field] = node?.kind === "record" && isFields(value)
      ? Object.fromEntries(Object.entries(value).map(([recordKey, item]) => [recordKey, parseItem(node.value, item, `${path}.${field}`)]))
      : validateField(shape, field, value, path);
  }
  for (const [field, nested] of Object.entries(delta.objects ?? {})) {
    const node = shape.fields?.[field];
    const current = next[field];
    if (!node || node.kind === "keyed") throw new Error(`Observation delta patches unknown object ${path}.${field}.`);
    if (!isFields(current)) throw new Error(`Observation delta patches missing object ${path}.${field}.`);
    if (node.kind === "record") {
      const record = applyFields(current, nested, recordShape(node, current), `${path}.${field}`);
      for (const recordKey of [...Object.keys(nested.set ?? {}), ...Object.keys(nested.objects ?? {})]) {
        record[recordKey] = parseItem(node.value, record[recordKey], `${path}.${field}`);
      }
      next[field] = record;
    } else {
      const applied = applyFields(current, nested, node.shape, `${path}.${field}`);
      next[field] = node.shape.validate ? parseItem(node.shape.validate, applied, `${path}.${field}`) : applied;
    }
  }
  for (const [field, keyed] of Object.entries(delta.collections ?? {})) {
    const node = shape.fields?.[field];
    const current = next[field];
    if (node?.kind !== "keyed" || !Array.isArray(current)) throw new Error(`Observation delta patches unknown collection ${path}.${field}.`);
    next[field] = applyKeyed(current, keyed, node, `${path}.${field}`);
  }
  return next;
}

function parseItem(schema: z.ZodType, item: unknown, path: string) {
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw new Error(`Observation delta carried an invalid item in ${path}.`);
  return parsed.data;
}

function applyKeyed(items: readonly unknown[], delta: KeyedDelta, node: Extract<ObservationShapeNode, { kind: "keyed" }>, path: string) {
  const keyOf = node.key as (item: unknown) => string;
  const byKey = new Map(items.map(item => [keyOf(item), item]));
  const order = items.map(keyOf);
  const removed = new Set(delta.remove ?? []);
  for (const itemKey of removed) if (!byKey.delete(itemKey)) throw new Error(`Observation delta removes missing ${path} item.`);
  for (const { key: itemKey, delta: itemDelta } of delta.update ?? []) {
    const current = byKey.get(itemKey);
    if (!isFields(current)) throw new Error(`Observation delta updates missing ${path} item.`);
    const shape = node.shape ?? {};
    const merged = applyFields(current, itemDelta, shape, path);
    byKey.set(itemKey, shape.schema ? merged : parseItem(node.item, merged, path));
  }
  const added: string[] = [];
  for (const { key: itemKey, item } of delta.add ?? []) {
    if (byKey.has(itemKey)) throw new Error(`Observation delta adds a duplicate ${path} item.`);
    const parsed = parseItem(node.item, item, path);
    if (keyOf(parsed) !== itemKey) throw new Error(`Observation delta added a ${path} item under the wrong key.`);
    byKey.set(itemKey, parsed);
    added.push(itemKey);
  }
  const sequence = [...order.filter(itemKey => byKey.has(itemKey) && !added.includes(itemKey)), ...added];
  for (const { key: itemKey, after = null } of delta.move ?? []) {
    const from = sequence.indexOf(itemKey);
    if (from < 0 || (after !== null && !byKey.has(after))) throw new Error(`Observation delta moves a missing ${path} item.`);
    sequence.splice(from, 1);
    sequence.splice(after === null ? 0 : sequence.indexOf(after) + 1, 0, itemKey);
  }
  return sequence.map(itemKey => byKey.get(itemKey));
}

const shortKey = (value: string) => {
  const tail = value.slice(value.lastIndexOf(":") + 1);
  return tail.slice(tail.lastIndexOf("/") + 1).slice(0, 8);
};

/**
 * One bounded line: `phase rows +1 ~2 -0 [89d36db6: activityAt,lifecycle] [c6c7f1bd: title] [+0a1b2c3d]`.
 * Names at most three keys per collection; reads only keys and field names, never values.
 */
export function describeObservationDelta(delta: ObservationDelta, limit = 3): string {
  const parts: string[] = [];
  const fields = [...Object.keys(delta.set ?? {}), ...(delta.unset ?? []).map(field => `-${field}`)];
  if (fields.length) parts.push(`${fields.slice(0, 8).join(",")}${fields.length > 8 ? ",..." : ""}`);
  for (const [field, nested] of Object.entries(delta.objects ?? {})) {
    const inner = describeObservationDelta(nested, limit);
    if (inner) parts.push(`${field}{${inner}}`);
  }
  for (const [field, keyed] of Object.entries(delta.collections ?? {})) {
    const counts = `${field} +${keyed.add?.length ?? 0} ~${keyed.update?.length ?? 0} -${keyed.remove?.length ?? 0}`
      + (keyed.move?.length ? ` moved ${keyed.move.length}` : "");
    const named = [
      ...(keyed.update ?? []).map(update => {
        const inner = describeObservationDelta(update.delta, limit);
        return `${shortKey(update.key)}${inner ? `: ${inner}` : ""}`;
      }),
      ...(keyed.add ?? []).map(added => `+${shortKey(added.key)}`),
      ...(keyed.remove ?? []).map(removed => `-${shortKey(removed)}`),
    ];
    const listed = named.slice(0, limit).map(item => `[${item}]`).join(" ");
    parts.push([counts, listed, named.length > limit ? `+${named.length - limit} more` : ""].filter(Boolean).join(" "));
  }
  return parts.join(" ").slice(0, 400);
}

/** Total keyed items touched, for naming oversized deltas. */
export function measureObservationDelta(delta: ObservationDelta): number {
  let count = Object.keys(delta.set ?? {}).length + (delta.unset?.length ?? 0);
  for (const nested of Object.values(delta.objects ?? {})) count += measureObservationDelta(nested);
  for (const keyed of Object.values(delta.collections ?? {})) {
    count += (keyed.add?.length ?? 0) + (keyed.remove?.length ?? 0) + (keyed.move?.length ?? 0);
    for (const update of keyed.update ?? []) count += 1 + measureObservationDelta(update.delta);
  }
  return count;
}
