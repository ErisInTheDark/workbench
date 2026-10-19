/*
 * Exports:
 * - ZodSchemaConformance: repaired value and paths substituted from trusted defaults.
 * - ZodSchemaRepair: fallback-free repair result, separating discarded data from harmless drift.
 * - conformToZodSchema: repair schema nodes with optional trusted defaults, preserving valid siblings.
 */
import { z } from "zod";

export interface ZodSchemaConformance<TValue> {
  data: TValue;
  fallbackPaths: PropertyKey[][];
  repairedPaths: PropertyKey[][];
}

export type ZodSchemaRepair<TValue> = {
  repairedPaths: PropertyKey[][];
  discardedPaths: PropertyKey[][];
} & ({ success: true; data: TValue } | { success: false });

type ZodSchema = z.ZodType;
const NO_DEFAULT = Symbol("no schema default");

function classicSchema(schema: z.core.SomeType): ZodSchema {
  return schema as ZodSchema;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addRepair(repairedPaths: PropertyKey[][], path: PropertyKey[]) {
  if (repairedPaths.some((candidate) => candidate.length === path.length && candidate.every((part, index) => Object.is(part, path[index])))) return;
  repairedPaths.push(path);
}

function fallbackValue(
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
) {
  addRepair(repairedPaths, path);
  addRepair(fallbackPaths, path);
  return fallback;
}

function conformObject(
  schema: z.ZodObject,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
  discardedPaths: PropertyKey[][],
) {
  if (!isRecord(value) || (fallback !== NO_DEFAULT && !isRecord(fallback))) {
    return fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  }
  const candidate: Record<PropertyKey, unknown> = { ...value };
  for (const [key, childSchema] of Object.entries(schema.shape)) {
    const childPath = [...path, key];
    const child = conformInput(classicSchema(childSchema), value[key],
      isRecord(fallback) ? fallback[key] : NO_DEFAULT, childPath, repairedPaths, fallbackPaths, discardedPaths);
    if (child === NO_DEFAULT && childSchema.safeParse(undefined).success) {
      delete candidate[key];
      addRepair(discardedPaths, childPath);
    } else if (child === undefined && (!isRecord(fallback) || !Object.hasOwn(fallback, key))) delete candidate[key];
    else candidate[key] = child;
  }

  const firstAttempt = schema.safeParse(candidate);
  if (firstAttempt.success) return candidate;
  for (const issue of firstAttempt.error.issues) {
    if (issue.code !== "unrecognized_keys" || issue.path.length) continue;
    for (const key of issue.keys) {
      delete candidate[key];
      addRepair(repairedPaths, [...path, key]);
    }
  }
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
}

function conformArray(
  schema: z.ZodArray,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
  discardedPaths: PropertyKey[][],
) {
  if (!Array.isArray(value) || (fallback !== NO_DEFAULT && !Array.isArray(fallback))) {
    return fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  }
  const elementSchema = classicSchema(schema.element);
  const candidate = value.flatMap((item, index) => {
    if (elementSchema.safeParse(item).success) return [item];
    if (Array.isArray(fallback) && index < fallback.length) {
      return [conformInput(elementSchema, item, fallback[index], [...path, index], repairedPaths, fallbackPaths, discardedPaths)];
    }
    // Without a default entry, the entry is its own template: only fallback-free repairs, such as
    // dropping unrecognized keys, can apply. Anything still invalid is dropped.
    const entryRepairs: PropertyKey[][] = [];
    const entryFallbacks: PropertyKey[][] = [];
    const entryDiscards: PropertyKey[][] = [];
    const repaired = conformInput(elementSchema, item, fallback === NO_DEFAULT ? NO_DEFAULT : item,
      [...path, index], entryRepairs, entryFallbacks, entryDiscards);
    if (elementSchema.safeParse(repaired).success) {
      for (const repairedPath of entryRepairs) addRepair(repairedPaths, repairedPath);
      for (const fallbackPath of entryFallbacks) addRepair(fallbackPaths, fallbackPath);
      for (const discardedPath of entryDiscards) addRepair(discardedPaths, discardedPath);
      return [repaired];
    }
    addRepair(repairedPaths, [...path, index]);
    addRepair(discardedPaths, [...path, index]);
    return [];
  });
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
}

function conformRecord(
  schema: z.ZodRecord,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
  discardedPaths: PropertyKey[][],
) {
  if (!isRecord(value) || (fallback !== NO_DEFAULT && !isRecord(fallback))) {
    return fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  }
  const keySchema = classicSchema(schema.keyType);
  const valueSchema = classicSchema(schema.valueType);
  const candidate: Record<PropertyKey, unknown> = { ...value };
  for (const key of Reflect.ownKeys(candidate)) {
    if (!keySchema.safeParse(key).success) {
      delete candidate[key];
      addRepair(repairedPaths, [...path, key]);
      addRepair(discardedPaths, [...path, key]);
      continue;
    }
    if (valueSchema.safeParse(candidate[key]).success) continue;
    if (isRecord(fallback) && Object.hasOwn(fallback, key)) {
      candidate[key] = conformInput(valueSchema, candidate[key], fallback[key], [...path, key],
        repairedPaths, fallbackPaths, discardedPaths);
    } else if (fallback === NO_DEFAULT) {
      const child = conformInput(valueSchema, candidate[key], NO_DEFAULT, [...path, key],
        repairedPaths, fallbackPaths, discardedPaths);
      if (child !== NO_DEFAULT && valueSchema.safeParse(child).success) candidate[key] = child;
      else {
        delete candidate[key];
        addRepair(discardedPaths, [...path, key]);
      }
    } else {
      delete candidate[key];
      addRepair(repairedPaths, [...path, key]);
    }
  }
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
}

function conformUnion(
  schema: z.ZodUnion,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
  discardedPaths: PropertyKey[][],
) {
  if (fallback === NO_DEFAULT) {
    const discriminator = schema instanceof z.ZodDiscriminatedUnion ? schema.def.discriminator : null;
    for (const option of schema.options.map(classicSchema)) {
      if (discriminator && (!isRecord(value) || !(option instanceof z.ZodObject)
        || !option.shape[discriminator]?.safeParse(value[discriminator]).success)) continue;
      const repairs: PropertyKey[][] = [];
      const discards: PropertyKey[][] = [];
      const candidate = conformInput(option, value, NO_DEFAULT, path, repairs, [], discards);
      if (!schema.safeParse(candidate).success) continue;
      for (const repair of repairs) addRepair(repairedPaths, repair);
      for (const discard of discards) addRepair(discardedPaths, discard);
      return candidate;
    }
    return fallbackValue(NO_DEFAULT, path, repairedPaths, fallbackPaths);
  }
  const fallbackOption = schema.options.map(classicSchema).find((option) => option.safeParse(fallback).success);
  if (!fallbackOption) return fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  const candidate = conformInput(fallbackOption, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
}

function unwrapSchema(schema: ZodSchema): ZodSchema | null {
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodPrefault
    || schema instanceof z.ZodNonOptional
    || schema instanceof z.ZodSuccess
    || schema instanceof z.ZodCatch
    || schema instanceof z.ZodReadonly
    || schema instanceof z.ZodLazy
  ) return classicSchema(schema.unwrap());
  return null;
}

function conformInput(
  schema: ZodSchema,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
  fallbackPaths: PropertyKey[][],
  discardedPaths: PropertyKey[][],
): unknown {
  if (schema.safeParse(value).success) return value;
  if (schema instanceof z.ZodObject) return conformObject(schema, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
  if (schema instanceof z.ZodArray) return conformArray(schema, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
  if (schema instanceof z.ZodRecord) return conformRecord(schema, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
  if (schema instanceof z.ZodUnion) return conformUnion(schema, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
  if (schema instanceof z.ZodPipe) {
    const candidate = conformInput(classicSchema(schema.in), value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
    return schema.safeParse(candidate).success
      ? candidate
      : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  }
  const unwrapped = unwrapSchema(schema);
  if (unwrapped) {
    const candidate = conformInput(unwrapped, value, fallback, path, repairedPaths, fallbackPaths, discardedPaths);
    return schema.safeParse(candidate).success
      ? candidate
      : fallbackValue(fallback, path, repairedPaths, fallbackPaths);
  }
  return fallbackValue(fallback, path, repairedPaths, fallbackPaths);
}

export function conformToZodSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  defaults: z.input<TSchema>,
): ZodSchemaConformance<z.output<TSchema>>;
export function conformToZodSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): ZodSchemaRepair<z.output<TSchema>>;
export function conformToZodSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  defaults?: z.input<TSchema>,
): ZodSchemaConformance<z.output<TSchema>> | ZodSchemaRepair<z.output<TSchema>> {
  if (arguments.length < 3) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { success: true, data: parsed.data, repairedPaths: [], discardedPaths: [] };
    const repairedPaths: PropertyKey[][] = [];
    const discardedPaths: PropertyKey[][] = [];
    const candidate = conformInput(schema, value, NO_DEFAULT, [], repairedPaths, [], discardedPaths);
    const result = schema.safeParse(candidate);
    return result.success
      ? { success: true, data: result.data, repairedPaths, discardedPaths }
      : { success: false, repairedPaths, discardedPaths };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { data: parsed.data, fallbackPaths: [], repairedPaths: [] };

  const parsedDefaults = schema.safeParse(defaults);
  if (!parsedDefaults.success) throw parsedDefaults.error;

  const repairedPaths: PropertyKey[][] = [];
  const fallbackPaths: PropertyKey[][] = [];
  const candidate = conformInput(schema, value, defaults, [], repairedPaths, fallbackPaths, []);
  const conformed = schema.safeParse(candidate);
  if (conformed.success) return { data: conformed.data, fallbackPaths, repairedPaths };
  addRepair(repairedPaths, []);
  addRepair(fallbackPaths, []);
  return { data: parsedDefaults.data, fallbackPaths, repairedPaths };
}
