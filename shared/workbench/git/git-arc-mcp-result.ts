/*
 * Exports:
 * - GitArcMcpResultSchema/GitArcMcpResult: typed Git arc MCP outcomes separate from display text.
 * - readGitArcMcpResult: repair usable success facts and reject malformed terminal outcomes without throwing.
 */
import { z } from "zod";
import type { JsonValue } from "../thread/workbench-thread-items.ts";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import { GitCheckpointFileChangeSchema } from "./git-checkpoint-file-change.ts";
import { GitArcFailureSchema } from "./git-arc-failures.ts";
import { GitArcReceiptSchema } from "./git-arc-receipts.ts";
import { GitArcStatusPresentationSchema } from "./git-arc-status.ts";

const successSchema = z.object({
  kind: z.literal("success"),
  version: z.literal(1),
  receipt: GitArcReceiptSchema.nullable().default(null),
  status: GitArcStatusPresentationSchema.partial().default({}),
  changes: z.array(GitCheckpointFileChangeSchema).default([]),
  diff: z.string().nullable().default(null),
}).strict();

const failureSchema = z.object({
  kind: z.literal("failure"),
  version: z.literal(1),
  failure: GitArcFailureSchema,
}).strict();

const interruptionSchema = z.object({
  kind: z.literal("interruptedBySteer"),
  version: z.literal(1),
}).strict();

export const GitArcMcpResultSchema = z.discriminatedUnion("kind", [
  successSchema, failureSchema, interruptionSchema,
]);
export type GitArcMcpResult = z.infer<typeof GitArcMcpResultSchema>;

const successDefaults = {
  kind: "success" as const,
  version: 1 as const,
  receipt: null,
  status: {},
  changes: [],
  diff: null,
};

export function readGitArcMcpResult(value: JsonValue | null) {
  if (value === null) return null;
  const kind = z.object({ kind: z.enum(["success", "failure", "interruptedBySteer"]) }).safeParse(value);
  if (!kind.success) return { kind: "invalid" as const, error: kind.error };
  const version = z.object({ version: z.literal(1) }).safeParse(value);
  if (!version.success) return { kind: "invalid" as const, error: version.error };
  if (kind.data.kind === "success") {
    const parsed = successSchema.safeParse(value);
    if (parsed.success) return { kind: "valid" as const, result: parsed.data, error: null };
    return {
      kind: "valid" as const,
      result: conformToZodSchema(successSchema, value, successDefaults).data,
      error: parsed.error,
    };
  }
  const parsed = kind.data.kind === "failure" ? failureSchema.safeParse(value) : interruptionSchema.safeParse(value);
  return parsed.success
    ? { kind: "valid" as const, result: parsed.data, error: null }
    : { kind: "invalid" as const, error: parsed.error };
}
