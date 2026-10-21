/*
 * Exports:
 * - WorkbenchSearchActionId/WORKBENCH_SEARCH_ACTIONS: shared searchable action metadata.
 * - WorkbenchSearchKind/Schema: the kinds of thing search finds.
 * - WorkbenchSearchRequest/Response/Result/Correction and schemas: typed workspace-search RPC contract; results carry an
 *   optional cross-source score, thread hits an optional explaining excerpt, responses the typo corrections they applied.
 * - WORKBENCH_SEARCH_RESULT_LIMIT: most hits one response carries.
 * - WORKBENCH_SEARCH_KIND_LIMITS: per-kind result caps that keep every kind of hit reachable.
 * - arrangeWorkbenchSearchResults: filter hits to the requested kinds and group them into kind sections ordered by their best score.
 */
import { z } from "zod";

export const WORKBENCH_SEARCH_RESULT_LIMIT = 50;

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

const ActionIdSchema = z.enum(WORKBENCH_SEARCH_ACTIONS.map((action) => action.id) as [
  WorkbenchSearchActionId,
  ...WorkbenchSearchActionId[],
]);
const CommonResultSchema = z.object({
  detail: z.string(),
  id: z.string(),
  /** Relevance comparable across sources; absent from older daemons. */
  score: z.number().optional(),
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
    /** The message that best explains the match; absent for title-only hits and from older daemons. */
    excerpt: z.object({ role: z.enum(["user", "agent"]), text: z.string() }).strict().optional(),
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

export const WorkbenchSearchKindSchema = z.enum(["thread", "file", "project", "projectSetting", "action"]);
export type WorkbenchSearchKind = z.infer<typeof WorkbenchSearchKindSchema>;

export const WorkbenchSearchRequestSchema = z.object({
  /** Only these kinds; absent means every kind. */
  kinds: z.array(WorkbenchSearchKindSchema).min(1).optional(),
  projectId: z.string().nullable(),
  /** Threads only from `projectId`; files and settings are always project-scoped. */
  projectOnly: z.boolean().optional(),
  query: z.string(),
}).strict();
export const WorkbenchSearchCorrectionSchema = z.object({ from: z.string(), to: z.string() }).strict();
export const WorkbenchSearchResponseSchema = z.object({
  /** Query words that matched nothing and were searched as these nearby spellings instead. */
  corrections: z.array(WorkbenchSearchCorrectionSchema).max(16).optional(),
  results: z.array(WorkbenchSearchResultSchema).max(WORKBENCH_SEARCH_RESULT_LIMIT),
}).strict();

export type WorkbenchSearchRequest = z.infer<typeof WorkbenchSearchRequestSchema>;
export type WorkbenchSearchResult = z.infer<typeof WorkbenchSearchResultSchema>;
export type WorkbenchSearchResponse = z.infer<typeof WorkbenchSearchResponseSchema>;
export type WorkbenchSearchCorrection = z.infer<typeof WorkbenchSearchCorrectionSchema>;

/** Listed in tie-break order; the caps sum to the response maximum. */
export const WORKBENCH_SEARCH_KIND_LIMITS: Readonly<Record<WorkbenchSearchKind, number>> = {
  thread: 25,
  file: 12,
  project: 5,
  projectSetting: 4,
  action: 4,
};
const KIND_ORDER = Object.keys(WORKBENCH_SEARCH_KIND_LIMITS) as WorkbenchSearchKind[];

/**
 * Hits stay in score order inside their kind, each kind keeps its own cap so one kind cannot crowd out the rest,
 * and the kind holding the strongest hit leads. Unscored hits keep their incoming order behind scored ones.
 * Hits outside `kinds` are dropped; a single requested kind may fill the whole response.
 */
export function arrangeWorkbenchSearchResults<Item>(
  items: readonly Item[],
  read: (item: Item) => WorkbenchSearchResult,
  kinds?: readonly WorkbenchSearchKind[],
) {
  const sections = new Map<WorkbenchSearchKind, Item[]>();
  const limit = (kind: WorkbenchSearchKind) => kinds?.length === 1 ? WORKBENCH_SEARCH_RESULT_LIMIT : WORKBENCH_SEARCH_KIND_LIMITS[kind];
  const ordered = items.map((item, index) => ({ index, item, score: read(item).score ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const { item } of ordered) {
    const kind = read(item).kind;
    if (kinds && !kinds.includes(kind)) continue;
    const section = sections.get(kind) ?? [];
    if (section.length < limit(kind)) section.push(item);
    sections.set(kind, section);
  }
  const best = (kind: WorkbenchSearchKind) => read(sections.get(kind)![0]!).score ?? Number.NEGATIVE_INFINITY;
  return [...sections.keys()]
    .sort((left, right) => best(right) - best(left) || KIND_ORDER.indexOf(left) - KIND_ORDER.indexOf(right))
    .flatMap(kind => sections.get(kind)!);
}
