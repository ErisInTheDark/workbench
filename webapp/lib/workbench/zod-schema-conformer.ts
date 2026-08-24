/*
 * Exports:
 * - ZodSchemaConformance/conformToZodSchema: repair invalid schema nodes from a conformant default while preserving valid siblings. Keywords: zod, schema, default, repair, conformance.
 */
import { z } from "zod";

export interface ZodSchemaConformance<TValue> {
  data: TValue;
  repairedPaths: PropertyKey[][];
}

type ZodSchema = z.ZodType;

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

function fallbackValue(fallback: unknown, path: PropertyKey[], repairedPaths: PropertyKey[][]) {
  addRepair(repairedPaths, path);
  return fallback;
}

function conformObject(
  schema: z.ZodObject,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
) {
  if (!isRecord(value) || !isRecord(fallback)) return fallbackValue(fallback, path, repairedPaths);
  const candidate: Record<PropertyKey, unknown> = { ...value };
  for (const [key, childSchema] of Object.entries(schema.shape)) {
    const child = conformInput(classicSchema(childSchema), value[key], fallback[key], [...path, key], repairedPaths);
    if (child === undefined && !Object.hasOwn(fallback, key)) delete candidate[key];
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
    : fallbackValue(fallback, path, repairedPaths);
}

function conformArray(
  schema: z.ZodArray,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
) {
  if (!Array.isArray(value) || !Array.isArray(fallback)) return fallbackValue(fallback, path, repairedPaths);
  const elementSchema = classicSchema(schema.element);
  const candidate = value.flatMap((item, index) => {
    if (elementSchema.safeParse(item).success) return [item];
    if (index < fallback.length) {
      return [conformInput(elementSchema, item, fallback[index], [...path, index], repairedPaths)];
    }
    addRepair(repairedPaths, [...path, index]);
    return [];
  });
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths);
}

function conformRecord(
  schema: z.ZodRecord,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
) {
  if (!isRecord(value) || !isRecord(fallback)) return fallbackValue(fallback, path, repairedPaths);
  const keySchema = classicSchema(schema.keyType);
  const valueSchema = classicSchema(schema.valueType);
  const candidate: Record<PropertyKey, unknown> = { ...value };
  for (const key of Reflect.ownKeys(candidate)) {
    if (!keySchema.safeParse(key).success) {
      delete candidate[key];
      addRepair(repairedPaths, [...path, key]);
      continue;
    }
    if (valueSchema.safeParse(candidate[key]).success) continue;
    if (Object.hasOwn(fallback, key)) {
      candidate[key] = conformInput(valueSchema, candidate[key], fallback[key], [...path, key], repairedPaths);
    } else {
      delete candidate[key];
      addRepair(repairedPaths, [...path, key]);
    }
  }
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths);
}

function conformUnion(
  schema: z.ZodUnion,
  value: unknown,
  fallback: unknown,
  path: PropertyKey[],
  repairedPaths: PropertyKey[][],
) {
  const fallbackOption = schema.options.map(classicSchema).find((option) => option.safeParse(fallback).success);
  if (!fallbackOption) return fallbackValue(fallback, path, repairedPaths);
  const candidate = conformInput(fallbackOption, value, fallback, path, repairedPaths);
  return schema.safeParse(candidate).success
    ? candidate
    : fallbackValue(fallback, path, repairedPaths);
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
): unknown {
  if (schema.safeParse(value).success) return value;
  if (schema instanceof z.ZodObject) return conformObject(schema, value, fallback, path, repairedPaths);
  if (schema instanceof z.ZodArray) return conformArray(schema, value, fallback, path, repairedPaths);
  if (schema instanceof z.ZodRecord) return conformRecord(schema, value, fallback, path, repairedPaths);
  if (schema instanceof z.ZodUnion) return conformUnion(schema, value, fallback, path, repairedPaths);
  if (schema instanceof z.ZodPipe) {
    const candidate = conformInput(classicSchema(schema.in), value, fallback, path, repairedPaths);
    return schema.safeParse(candidate).success
      ? candidate
      : fallbackValue(fallback, path, repairedPaths);
  }
  const unwrapped = unwrapSchema(schema);
  if (unwrapped) {
    const candidate = conformInput(unwrapped, value, fallback, path, repairedPaths);
    return schema.safeParse(candidate).success
      ? candidate
      : fallbackValue(fallback, path, repairedPaths);
  }
  return fallbackValue(fallback, path, repairedPaths);
}

export function conformToZodSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  defaults: z.input<TSchema>,
): ZodSchemaConformance<z.output<TSchema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { data: parsed.data, repairedPaths: [] };

  const parsedDefaults = schema.safeParse(defaults);
  if (!parsedDefaults.success) throw parsedDefaults.error;

  const repairedPaths: PropertyKey[][] = [];
  const candidate = conformInput(schema, value, defaults, [], repairedPaths);
  const conformed = schema.safeParse(candidate);
  if (conformed.success) return { data: conformed.data, repairedPaths };
  addRepair(repairedPaths, []);
  return { data: parsedDefaults.data, repairedPaths };
}
