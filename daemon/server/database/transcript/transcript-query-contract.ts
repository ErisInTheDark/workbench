/*
 * Exports:
 * - TranscriptQuerySchema/TranscriptQuery: validate the stored-history command vocabulary.
 * - TranscriptField/TranscriptQueryRow/TranscriptQueryPage: bounded display records shared by worker and CLI.
 * - TranscriptQueryError: expected invalid query or stale-reference failure.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

const text = z.string().min(1).max(4096);
export const TranscriptQuerySchema = z.object({
  action: z.enum(["projects", "threads", "turns", "search", "read", "show", "stats"]),
  threads: z.array(text).max(50).default([]),
  project: text.nullable().default(null),
  harness: ProviderKeySchema.nullable().default(null),
  turn: text.nullable().default(null),
  kinds: z.array(z.enum(["user-message", "user-steer", "assistant-message", "plan", "reasoning", "process", "tool", "collaboration", "tool-output", "file-change", "web-search", "questionnaire", "approval", "compaction", "unknown"])).default([]),
  phase: z.enum(["commentary", "finalAnswer", "unknown"]).nullable().default(null),
  tool: text.nullable().default(null),
  file: text.nullable().default(null),
  since: z.number().int().nonnegative().nullable().default(null),
  until: z.number().int().nonnegative().nullable().default(null),
  archived: z.boolean().nullable().default(null),
  settled: z.boolean().nullable().default(null),
  queries: z.array(text).max(20).default([]),
  excludes: z.array(text).max(20).default([]),
  any: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  opaque: z.boolean().default(false),
  item: text.nullable().default(null),
  around: text.nullable().default(null),
  context: z.number().int().min(0).max(50).default(5),
  limit: z.number().int().min(1).max(50).default(20),
  direction: z.enum(["older", "newer"]).default("older"),
  cursor: z.string().min(1).max(16000).nullable().default(null),
  json: z.boolean().default(false),
}).strict().superRefine((query, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (["read", "show", "turns"].includes(query.action) && query.threads.length !== 1) fail("Pass exactly one --thread <wb-thread-id>.");
  if (query.action === "show" && !query.item) fail("--item is required.");
  if (query.action === "search" && !query.queries.length) fail("At least one --query is required.");
  if (query.since !== null && query.until !== null && query.since > query.until) fail("--since must not follow --until.");
  if (query.around && query.action !== "read") fail("--around is only valid for read.");
  if (query.item && query.action !== "show") fail("--item is only valid for show.");
  if (query.turn && !query.threads.length) fail("--turn requires --thread.");
});
export type TranscriptQuery = z.output<typeof TranscriptQuerySchema>;

export interface TranscriptField {
  path: (string | number)[];
  value: string | number | boolean | null | [] | Record<string, never>;
  /** Present only when a string is abbreviated or split across pages. */
  offset?: number;
  length?: number;
}

export interface TranscriptQueryRow {
  kind: string;
  id: string;
  threadId: string | null;
  turnId: string | null;
  projectId: string | null;
  title: string;
  createdAt: number | null;
  fields: TranscriptField[];
  counts: Record<string, number>;
}

export interface TranscriptQueryPage {
  rows: TranscriptQueryRow[];
  coverage: { threads: number; turns: number; materializedTurns: number; items: number };
  nextCursor: string | null;
  scanned: number;
}

export class TranscriptQueryError extends Error {}
