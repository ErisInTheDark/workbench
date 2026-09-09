/*
 * Keywords: search, fuzzy, bounded edit distance, query-local scoring.
 * Exports:
 * - WorkbenchSearchActionId/WORKBENCH_SEARCH_ACTIONS: shared searchable action metadata. Keywords: search, action, shortcut, registry.
 * - WorkbenchSearchRequest/Response/Result and schemas: typed workspace-search RPC contract. Keywords: search, zod, rpc.
 * - WorkbenchSearchFieldKind/WorkbenchSearchField: weighted searchable text contracts.
 * - WorkbenchSearchClause: parsed positive or excluded word/phrase.
 * - parseWorkbenchSearchQuery/rankWorkbenchSearchFields: fuzzy per-word query grammar and weighted field scorer. Keywords: search, fuzzy, phrase, negative, ranking.
 * - createWorkbenchSearchMatcher: reusable query-scoped scorer with memoised token comparisons.
 */
import { z } from "zod";

export const WORKBENCH_SEARCH_ACTIONS = [
  { id: "toggle-sidebar", title: "Toggle sidebar", shortcut: "Ctrl+B" },
  { id: "zoom-in", title: "Zoom in", shortcut: "Ctrl++" },
  { id: "zoom-out", title: "Zoom out", shortcut: "Ctrl+-" },
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `view-thread-${index + 1}` as const,
    title: `View thread ${index + 1}`,
    shortcut: `Ctrl+${index === 9 ? 0 : index + 1}`,
  })),
  { id: "create-thread", title: "Create thread", shortcut: "Ctrl+M" },
  { id: "home", title: "Home", shortcut: "Ctrl+H" },
  { id: "settings", title: "Settings", shortcut: "Ctrl+O" },
] as const;

export type WorkbenchSearchActionId = typeof WORKBENCH_SEARCH_ACTIONS[number]["id"];
export type WorkbenchSearchFieldKind = "title" | "userMessage" | "commentary" | "filePath";
export interface WorkbenchSearchField {
  kind: WorkbenchSearchFieldKind;
  text: string;
}

export type WorkbenchSearchClause = {
  excluded: boolean;
  kind: "phrase" | "word";
  value: string;
};

const ActionIdSchema = z.enum(WORKBENCH_SEARCH_ACTIONS.map((action) => action.id) as [
  WorkbenchSearchActionId,
  ...WorkbenchSearchActionId[],
]);
const CommonResultSchema = z.object({
  detail: z.string(),
  id: z.string(),
  title: z.string(),
});

export const WorkbenchSearchResultSchema = z.discriminatedUnion("kind", [
  CommonResultSchema.extend({ actionId: ActionIdSchema, kind: z.literal("action") }).strict(),
  CommonResultSchema.extend({ kind: z.literal("project"), projectId: z.string() }).strict(),
  CommonResultSchema.extend({
    kind: z.literal("projectSetting"),
    projectId: z.string(),
    settingKey: z.string(),
  }).strict(),
  CommonResultSchema.extend({
    harnessId: z.string(),
    kind: z.literal("thread"),
    projectId: z.string(),
    threadId: z.string(),
  }).strict(),
  CommonResultSchema.extend({
    kind: z.literal("file"),
    path: z.string(),
    projectId: z.string(),
  }).strict(),
]);

export const WorkbenchSearchRequestSchema = z.object({
  projectId: z.string().nullable(),
  query: z.string(),
}).strict();
export const WorkbenchSearchResponseSchema = z.object({
  results: z.array(WorkbenchSearchResultSchema).max(50),
}).strict();

export type WorkbenchSearchRequest = z.infer<typeof WorkbenchSearchRequestSchema>;
export type WorkbenchSearchResult = z.infer<typeof WorkbenchSearchResultSchema>;
export type WorkbenchSearchResponse = z.infer<typeof WorkbenchSearchResponseSchema>;

const FIELD_WEIGHTS: Record<WorkbenchSearchFieldKind, number> = {
  commentary: 2,
  filePath: 1,
  title: 8,
  userMessage: 4,
};

export function parseWorkbenchSearchQuery(query: string): WorkbenchSearchClause[] {
  const clauses: WorkbenchSearchClause[] = [];
  let index = 0;
  while (index < query.length) {
    while (/\s/u.test(query[index] ?? "")) index += 1;
    if (index >= query.length) break;
    let excluded = false;
    if (query[index] === "-") {
      excluded = true;
      index += 1;
    }
    if (query[index] === "\"") {
      index += 1;
      const end = query.indexOf("\"", index);
      const value = query.slice(index, end < 0 ? query.length : end).trim().toLocaleLowerCase();
      if (value) clauses.push({ excluded, kind: "phrase", value });
      index = end < 0 ? query.length : end + 1;
      continue;
    }
    const start = index;
    while (index < query.length && !/\s/u.test(query[index] ?? "")) index += 1;
    const value = query.slice(start, index).trim().toLocaleLowerCase();
    if (value) clauses.push({ excluded, kind: "word", value });
  }
  return clauses;
}

function boundedEditDistance(left: string, right: string, limit: number) {
  const exceeded = limit + 1;
  if (Math.abs(left.length - right.length) > limit) return exceeded;
  if (right.length > left.length) [left, right] = [right, left];
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index++) previous[index] = index <= limit ? index : exceeded;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const start = Math.max(1, leftIndex - limit);
    const end = Math.min(right.length, leftIndex + limit);
    current[0] = leftIndex <= limit ? leftIndex : exceeded;
    if (start > 1) current[start - 1] = exceeded;
    let minimum = current[0];
    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      );
      minimum = Math.min(minimum, current[rightIndex]);
    }
    if (minimum > limit) return exceeded;
    if (end < right.length) current[end + 1] = exceeded;
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function createClauseMatcher(clause: WorkbenchSearchClause) {
  if (clause.kind === "phrase") return (text: string) => text.includes(clause.value) ? 1 : 0;
  const needle = clause.value;
  const scores = new Map<string, number>();
  return (text: string) => {
    if (text === needle) return 1;
    if (text.startsWith(needle)) return 0.95;
    if (text.includes(needle)) return 0.9;
    let best = 0;
    for (const [word] of text.matchAll(/[\p{L}\p{N}_./\\-]+/gu)) {
      let score = scores.get(word);
      if (score === undefined) {
        const length = Math.max(needle.length, word.length);
        const limit = Math.max(1, Math.floor(length / 3));
        const distance = boundedEditDistance(needle, word, limit);
        score = distance <= limit ? 0.75 * (1 - distance / length) : 0;
        scores.set(word, score);
      }
      best = Math.max(best, score);
    }
    return best;
  };
}

export function rankWorkbenchSearchFields(
  clauses: readonly WorkbenchSearchClause[],
  fields: readonly WorkbenchSearchField[],
) {
  return createWorkbenchSearchMatcher(clauses)(fields);
}

export function createWorkbenchSearchMatcher(clauses: readonly WorkbenchSearchClause[]) {
  const negatives = clauses.filter((clause) => clause.excluded).map(createClauseMatcher);
  const positives = clauses.filter((clause) => !clause.excluded).map(createClauseMatcher);
  return (fields: readonly WorkbenchSearchField[]) => {
    const normalized = fields.map((field) => ({ kind: field.kind, text: field.text.toLocaleLowerCase() }));
    if (negatives.some((match) => normalized.some((field) => match(field.text) > 0))) return null;

    let score = 0;
    let bestFieldKind: WorkbenchSearchFieldKind = fields[0]?.kind ?? "title";
    let bestFieldScore = -1;
    for (const match of positives) {
      let clauseScore = 0;
      let clauseField: WorkbenchSearchFieldKind | null = null;
      for (const field of normalized) {
        const weighted = match(field.text) * FIELD_WEIGHTS[field.kind];
        if (weighted > clauseScore) {
          clauseScore = weighted;
          clauseField = field.kind;
        }
      }
      if (!clauseField) return null;
      score += clauseScore;
      if (clauseScore > bestFieldScore) {
        bestFieldScore = clauseScore;
        bestFieldKind = clauseField;
      }
    }
    return { bestFieldKind, score };
  };
}
