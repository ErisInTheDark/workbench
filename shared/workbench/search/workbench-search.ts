/*
 * Exports:
 * - WorkbenchSearchActionId/WORKBENCH_SEARCH_ACTIONS: shared searchable action metadata. Keywords: search, action, shortcut, registry.
 * - WorkbenchSearchRequest/Response/Result and schemas: typed workspace-search RPC contract. Keywords: search, zod, rpc.
 * - parseWorkbenchSearchQuery/rankWorkbenchSearchFields: fuzzy per-word query grammar and weighted field scorer. Keywords: search, fuzzy, phrase, negative, ranking.
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

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function wordQuality(needle: string, text: string) {
  if (text === needle) return 1;
  if (text.startsWith(needle)) return 0.95;
  if (text.includes(needle)) return 0.9;
  let best = 0;
  for (const word of text.split(/[^\p{L}\p{N}_./\\-]+/u).filter(Boolean)) {
    const distance = editDistance(needle, word);
    const length = Math.max(needle.length, word.length);
    if (length > 0 && distance <= Math.max(1, Math.floor(length / 3))) {
      best = Math.max(best, 0.75 * (1 - distance / length));
    }
  }
  return best;
}

function clauseQuality(clause: WorkbenchSearchClause, text: string) {
  const normalized = text.toLocaleLowerCase();
  return clause.kind === "phrase"
    ? normalized.includes(clause.value) ? 1 : 0
    : wordQuality(clause.value, normalized);
}

export function rankWorkbenchSearchFields(
  clauses: readonly WorkbenchSearchClause[],
  fields: readonly WorkbenchSearchField[],
) {
  const negatives = clauses.filter((clause) => clause.excluded);
  if (negatives.some((clause) => fields.some((field) => clauseQuality(clause, field.text) > 0))) return null;

  let score = 0;
  let bestFieldKind: WorkbenchSearchFieldKind = fields[0]?.kind ?? "title";
  let bestFieldScore = -1;
  for (const clause of clauses.filter((entry) => !entry.excluded)) {
    let clauseScore = 0;
    let clauseField: WorkbenchSearchFieldKind | null = null;
    for (const field of fields) {
      const weighted = clauseQuality(clause, field.text) * FIELD_WEIGHTS[field.kind];
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
}
