/*
 * Exports:
 * - HISTORY_ITEM_KINDS/HistoryItemKind: item kinds shared by --kind filters, stats counts and item headers.
 * - HISTORY_NARRATIVE_KINDS/HistoryNarrativeKind: the user-visible conversation kinds Thread Recall reads.
 * - HISTORY_QUERY_ACTIONS: the stored-history actions.
 * - HistoryQuerySchema/HistoryQuery: validate one history query over either view.
 * - HistoryCommandFieldsSchema/HistoryCommandField: every command option, unrefined, for per-action tool schemas.
 * - HistoryCommandQuerySchema/HistoryCommandQuery: add explicit exact-turn provider recovery to CLI queries.
 * - HistoryField/HistoryRow/HistoryRecord/HistorySearchSummary/HistoryPage: bounded results shared by worker and front-ends.
 * - readHistoryAnchor: split a `ref[@offset]` anchor into its item id, derived-record suffix and character offset.
 * - HistoryQueryError: expected invalid query or stale-reference failure.
 */
import { z } from "zod";
import { WORKBENCH_THREAD_RECALL_KINDS, type WorkbenchThreadRecallKind } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

const text = z.string().min(1).max(4096);
export const HISTORY_ITEM_KINDS = [
  "user-message", "user-steer", "agent-message", "commentary", "final-answer", "plan", "reasoning", "process", "tool",
  "collaboration", "tool-output", "file-change", "web-search", "questionnaire", "approval", "compaction", "unknown",
] as const;
export type HistoryItemKind = typeof HISTORY_ITEM_KINDS[number];
export const HISTORY_NARRATIVE_KINDS = WORKBENCH_THREAD_RECALL_KINDS satisfies readonly HistoryItemKind[];
export type HistoryNarrativeKind = WorkbenchThreadRecallKind;
export const HISTORY_QUERY_ACTIONS = ["projects", "threads", "turns", "search", "read", "show", "stats"] as const;

const queryFields = {
  view: z.enum(["items", "narrative"]).default("items"),
  threads: z.array(text).max(50).default([]),
  project: text.nullable().default(null),
  harness: ProviderKeySchema.nullable().default(null),
  turn: text.nullable().default(null),
  kinds: z.array(z.enum(HISTORY_ITEM_KINDS)).default([]),
  phase: z.enum(["commentary", "finalAnswer", "unknown"]).nullable().default(null),
  tool: text.nullable().default(null),
  file: text.nullable().default(null),
  since: z.number().int().nonnegative().nullable().default(null),
  until: z.number().int().nonnegative().nullable().default(null),
  archived: z.boolean().nullable().default(null),
  settled: z.boolean().nullable().default(null),
  /** Words match in any order, "quoted phrases" exactly, -word excludes. */
  query: z.string().trim().min(1).max(500).nullable().default(null),
  opaque: z.boolean().default(false),
  item: text.nullable().default(null),
  before: text.nullable().default(null),
  after: text.nullable().default(null),
  around: text.nullable().default(null),
  context: z.number().int().min(0).max(50).default(5),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(16000).nullable().default(null),
  json: z.boolean().default(false),
};

export const HistoryQuerySchema = z.object({
  action: z.enum(HISTORY_QUERY_ACTIONS),
  ...queryFields,
}).strict().superRefine((query, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (["read", "show", "turns"].includes(query.action) && query.threads.length !== 1) fail("Pass exactly one --thread <wb-thread-id>.");
  if (query.action === "show" && !query.item) fail("--item is required.");
  if (query.action === "search" && !query.query) fail("--query is required.");
  if (query.since !== null && query.until !== null && query.since > query.until) fail("--since must not follow --until.");
  const anchors = [query.before, query.after, query.around].filter(Boolean).length;
  if (anchors && query.action !== "read") fail("--before, --after and --around are only valid for read.");
  if (anchors > 1) fail("Pass at most one of --before, --after and --around.");
  if (query.item && query.action !== "show") fail("--item is only valid for show.");
  if (query.turn && !query.threads.length) fail("--turn requires --thread.");
  if (query.view === "narrative") {
    if (!["read", "search"].includes(query.action)) fail("The narrative view only reads and searches.");
    if (query.threads.length !== 1) fail("The narrative view reads exactly one thread.");
    const itemFilters = [query.project, query.harness, query.phase, query.tool, query.file, query.since, query.until, query.archived, query.settled];
    if (itemFilters.some(value => value !== null) || query.opaque) fail("The narrative view filters only by thread, turn and kind.");
  }
  if (query.view === "narrative" && query.kinds.some(kind => !(HISTORY_NARRATIVE_KINDS as readonly string[]).includes(kind))) {
    fail(`Narrative kinds are: ${HISTORY_NARRATIVE_KINDS.join(", ")}.`);
  }
});
export type HistoryQuery = z.output<typeof HistoryQuerySchema>;

const providerField = { provider: z.boolean().default(false) };
/** Every command option without `action` or cross-field rules, so each action's tool can pick its own. */
export const HistoryCommandFieldsSchema = z.object({ ...queryFields, ...providerField }).strict();
export type HistoryCommandField = keyof typeof HistoryCommandFieldsSchema.shape;

export const HistoryCommandQuerySchema = HistoryQuerySchema.safeExtend(providerField).superRefine((query, context) => {
  if (!query.provider) return;
  if (!["read", "search", "show"].includes(query.action)) {
    context.addIssue({ code: "custom", message: "--provider is only valid for read, search and show." });
  }
  if (query.threads.length !== 1 || query.turn === null) {
    context.addIssue({ code: "custom", message: "--provider requires exactly one --thread and one --turn." });
  }
});
export type HistoryCommandQuery = z.output<typeof HistoryCommandQuerySchema>;

export interface HistoryField {
  path: (string | number)[];
  value: string | number | boolean | null | [] | Record<string, never>;
  /** Present only when a string is abbreviated or split across pages. */
  offset?: number;
  length?: number;
}

/** One item, catalogue entry or stats summary in the items view. */
export interface HistoryRow {
  kind: string;
  id: string;
  threadId: string | null;
  turnId: string | null;
  projectId: string | null;
  title: string;
  createdAt: number | null;
  fields: HistoryField[];
  counts: Record<string, number>;
  /** Search hits only: compact text around the first matched term. */
  excerpt?: string;
}

/** One user-visible conversation record in the narrative view. Derived plan records carry a `:plan<n>` ref suffix. */
export interface HistoryRecord {
  ref: string;
  itemId: string;
  kind: HistoryNarrativeKind;
  threadId: string;
  turnId: string | null;
  text: string;
  /** Text kept from a retention-expired turn; its kind is inferred from the speaker. */
  retained: boolean;
  /** Search hits only: compact text around the first matched term. */
  excerpt?: string;
}

export interface HistorySearchSummary {
  /** Hits holding every term, then hits holding only some; phrase exactness is checked as pages fill. */
  complete: number;
  partial: number;
  terms: { term: string; hits: number }[];
  corrections: { from: string; to: string }[];
  /** Share of older history the background backfill has indexed, 0..1; below 1 some older items are not searchable yet. */
  indexed: number;
}

export interface HistoryPage {
  rows: HistoryRow[];
  records: HistoryRecord[];
  /** `expiredTurns`: turns whose payload retention removed; only an explicit provider recovery brings one back. */
  coverage: { threads: number; turns: number; materializedTurns: number; expiredTurns: number; items: number };
  nextCursor: string | null;
  /** Reads only: whether stored history continues beyond the returned window. */
  older: boolean;
  newer: boolean;
  /** Reads only: never-materialised turns inside the window, newest first. */
  gaps: string[];
  /** Reads only: retention-expired turns inside the window with nothing recovered; only explicit recovery restores them. */
  expired: string[];
  search: HistorySearchSummary | null;
}

export function readHistoryAnchor(value: string) {
  const match = /^([^:@]+)(?::(plan\d+))?(?:@(\d+))?$/u.exec(value);
  if (!match) throw new HistoryQueryError(`Invalid history reference: ${value.slice(0, 200)}`);
  return { itemId: match[1]!, part: match[2] ?? null, offset: match[3] === undefined ? null : Number(match[3]) };
}

export class HistoryQueryError extends Error {}
