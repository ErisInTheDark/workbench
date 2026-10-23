/*
 * Exports:
 * - default WorkbenchHistoryQueryRepository: answer history queries over stored transcripts without materialising:
 *   catalogues, stats, chronological item or narrative windows around refs, index-backed ranked search and paged expansion.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "workbench-shared/types";
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import { foldSearchText, parseSearchQuery, searchBodyQuality, searchCorrections, searchExcerpt, type SearchClause } from "../search/workbench-search-ranking.ts";
import { agentMessageOutputSql, registerTranscriptAgentMessageFunction } from "../transcript/transcript-agent-message-sql.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import { historyKindSql } from "./history-fields.ts";
import { expandTranscriptFields, previewTranscriptFields, transcriptItemFields } from "./history-item-fields.ts";
import { isNarrativeUserMessage, narrativeRecords, retainedNarrativeRecord } from "./history-narrative.ts";
import {
  HISTORY_NARRATIVE_KINDS,
  HistoryQueryError,
  readHistoryAnchor,
  type HistoryField,
  type HistoryNarrativeKind,
  type HistoryPage,
  type HistoryQuery,
  type HistoryRecord,
  type HistoryRow,
  type HistorySearchSummary,
} from "./history-query-contract.ts";
import type WorkbenchHistoryIndex from "./WorkbenchHistoryIndex.ts";
import { historyAnyOf, historyClauseExpression, historyItemExpression } from "./WorkbenchHistoryIndex.ts";

const cursorSchema = z.object({
  version: z.literal(2), signature: z.string(), ceiling: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  field: z.number().int().nonnegative().nullable(), fieldOffset: z.number().int().nonnegative(), revision: z.string().nullable(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
type Bindings = Record<string, string | number | null>;
type Coverage = HistoryPage["coverage"];

interface ItemRow {
  id: number; publicId: string; threadId: string; turnId: string; projectId: string; title: string; kind: string;
  createdAt: number; ordTime: number; turnIndex: number; position: number; harness: string; inputKind: string | null;
}
/** A live item (positive key) or retained narrative (negated `workbench_search_narratives` id). */
interface NarrativeRow {
  key: number; publicId: string; turnId: string; turnIndex: number; position: number; harness: string;
  inputKind: string | null; role: "assistant" | "user" | null; text: string | null;
}
type Position = [number, number, number];
type Direction = "older" | "newer";

const BATCH_SIZE = 100;
/** A narrative window gathers about one recall page of text; the front-end trims it to its exact budget. */
const NARRATIVE_WINDOW_CHARACTERS = WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS;
/** Search pages project at most this many ranked candidates per call, so dropped hidden hits stay bounded. */
const MAX_SEARCH_PROJECTIONS = 400;
/** Each term contributes at most this many best-ranked candidates; counts still cover every match. */
const MAX_HITS_PER_TERM = 500;
/** Identifier words joined to a term ("recall" → "workbenchthreadrecallcontroller"), most widespread first. */
const MAX_IDENTIFIER_TERMS = 8;
const MAX_GAPS = 20;
const archivedPlacement = "COALESCE((SELECT archived FROM workbench_top_level_thread_states WHERE thread_id = th.id), th.archived)";
const itemJoins = `FROM thread_items i
  JOIN thread_turns tr ON tr.id = i.turn_id
  JOIN workbench_threads th ON th.id = i.thread_id
  LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
  LEFT JOIN thread_item_user_messages u ON u.item_id = i.id
  LEFT JOIN thread_item_assistant_messages a ON a.item_id = i.id
  LEFT JOIN thread_operation_process_sources p ON p.item_id = i.id
  LEFT JOIN thread_operation_tool_sources t ON t.item_id = i.id`;
const narrativeTypes = `(i.type IN ('userMessage', 'assistantMessage', 'questionnaire', 'approval')
  OR (i.type = 'functionCallOutput' AND ${agentMessageOutputSql("i")}))`;
const retainedTurn = "(SELECT alias.turn_id FROM workbench_transcript_item_source_aliases alias WHERE alias.item_identity_id = r.item_public_id LIMIT 1)";
const liveCopy = "EXISTS (SELECT 1 FROM thread_items live WHERE live.public_id = r.item_public_id)";

function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }
function signature(query: HistoryQuery) {
  const { cursor: _cursor, json: _json, limit: _limit, ...selection } = query;
  return digest(JSON.stringify(selection));
}
function encode(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function entry(row: ItemRow, fields: HistoryField[]): HistoryRow {
  return { id: row.publicId, threadId: row.threadId, turnId: row.turnId, projectId: row.projectId,
    title: row.title.slice(0, 300), kind: row.kind, createdAt: row.createdAt, fields, counts: {} };
}
function displayField(name: string, value: HistoryField["value"]): HistoryField { return { path: [name], value }; }
function fieldText(fields: readonly HistoryField[]) {
  return fields.flatMap(field => typeof field.value === "string" ? [field.value] : []).join("\n");
}
function narrativeKinds(query: HistoryQuery) {
  return new Set<HistoryNarrativeKind>(query.kinds.length ? query.kinds as HistoryNarrativeKind[] : HISTORY_NARRATIVE_KINDS);
}
/** Quoted phrases with punctuation are matched by FTS token runs; confirm the exact text before showing a hit. */
function exactPhrases(clauses: readonly SearchClause[]) {
  return clauses.filter(clause => clause.kind === "phrase" && clause.value !== clause.tokens.join(" ")).map(clause => clause.value);
}
function holdsPhrases(text: string, phrases: readonly string[]) {
  if (!phrases.length) return true;
  const folded = foldSearchText(text);
  return phrases.every(phrase => folded.includes(phrase));
}

export default class WorkbenchHistoryQueryRepository {
  constructor(
    private readonly database: Database.Database,
    /** Only the writer owns the index; search needs it, every other action runs on readers too. */
    private readonly index: WorkbenchHistoryIndex | null = null,
  ) {
    // SQLite's built-in lower() only folds ASCII. Keep literal matching Unicode-aware.
    database.function("wb_transcript_fold", { deterministic: true }, (value: string) => foldSearchText(value));
    registerTranscriptAgentMessageFunction(database);
  }

  read(query: HistoryQuery): HistoryPage {
    // The index refreshes outside the read transaction: reindexing writes to its TEMP tables.
    if (query.action === "search") this.requireIndex().refresh();
    return this.database.transaction(() => this.readTransaction(query))();
  }

  private requireIndex() {
    if (!this.index) throw new Error("History search runs only on the connection that owns the history index.");
    return this.index;
  }

  private readTransaction(query: HistoryQuery): HistoryPage {
    for (const id of query.threads) {
      if (!this.database.prepare("SELECT 1 FROM workbench_threads WHERE id = ?").get(id)) throw new HistoryQueryError(`Unknown Workbench thread: ${id}`);
    }
    if (query.turn && !this.database.prepare(`SELECT 1 FROM thread_turns WHERE id = ? AND thread_id IN (${query.threads.map(() => "?").join(",")})`).get(query.turn, ...query.threads)) {
      throw new HistoryQueryError("Unknown turn in the selected Workbench thread.");
    }
    const cursor = this.cursor(query);
    const coverage = this.coverage(query);
    switch (query.action) {
      case "stats": return this.stats(query, coverage);
      case "projects":
      case "threads":
      case "turns": return this.catalog(query, cursor, coverage);
      case "show": return this.show(query, cursor, coverage);
      case "search": return this.search(query, cursor, coverage);
      case "read": return query.view === "narrative" ? this.readNarrative(query, coverage) : this.readItems(query, coverage);
    }
  }

  private page(coverage: Coverage, page: Partial<HistoryPage>): HistoryPage {
    return { rows: [], records: [], coverage, nextCursor: null, older: false, newer: false, gaps: [], expired: [], search: null, ...page };
  }

  private cursor(query: HistoryQuery): Cursor {
    if (query.cursor) {
      try {
        const value = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
        if (value.signature !== signature(query)) throw new HistoryQueryError("Cursor belongs to different history filters.");
        return value;
      } catch (error) {
        if (error instanceof HistoryQueryError) throw error;
        throw new HistoryQueryError("Invalid history cursor.");
      }
    }
    const table = ["projects", "threads"].includes(query.action) ? "workbench_threads" : query.action === "turns" ? "thread_turns" : "thread_items";
    const { ceiling } = this.database.prepare(`SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM ${table}`).get() as { ceiling: number };
    return { version: 2, signature: signature(query), ceiling, offset: 0, field: null, fieldOffset: 0, revision: null };
  }

  private filters(query: HistoryQuery, bindings: Bindings, items = false) {
    const clauses = ["1"];
    const bind = (key: string, value: string | number) => { bindings[key] = value; return `@${key}`; };
    if (query.threads.length) clauses.push(`th.id IN (${query.threads.map((value, index) => bind(`thread${index}`, value)).join(",")})`);
    if (query.project) clauses.push(`th.project_id = ${bind("project", query.project)}`);
    if (query.archived !== null) clauses.push(`${archivedPlacement} = ${bind("archived", Number(query.archived))}`);
    if (query.settled !== null) clauses.push(`COALESCE(lc.settled, 0) = ${bind("settled", Number(query.settled))}`);
    if (query.harness) clauses.push(items || query.action === "turns"
      ? `tr.harness_id = ${bind("harness", query.harness)}`
      : `EXISTS (SELECT 1 FROM thread_turns ht WHERE ht.thread_id = th.id AND ht.harness_id = ${bind("harness", query.harness)})`);
    if (query.turn && (items || query.action === "turns")) clauses.push(`tr.id = ${bind("turn", query.turn)}`);
    const time = items ? "i.created_at" : query.action === "turns" ? "tr.created_at" : "th.activity_at";
    if (query.since !== null) clauses.push(`${time} >= ${bind("since", query.since)}`);
    if (query.until !== null) clauses.push(`${time} <= ${bind("until", query.until)}`);
    if (items) {
      if (query.view === "narrative") clauses.push(narrativeTypes);
      else if (query.kinds.length) clauses.push(`(${historyKindSql}) IN (${query.kinds.map((value, index) => bind(`kind${index}`, value)).join(",")})`);
      if (query.phase) clauses.push(`a.phase = ${bind("phase", query.phase)}`);
      if (query.tool) clauses.push(`(t.tool_name = ${bind("tool", query.tool)} OR EXISTS (SELECT 1 FROM thread_item_tool_outputs o WHERE o.item_id = i.id AND o.name = @tool))`);
      if (query.file) clauses.push(`EXISTS (SELECT 1 FROM thread_file_changes f WHERE f.item_id = i.id AND (instr(f.path, ${bind("file", query.file)}) > 0 OR instr(COALESCE(f.move_path, ''), @file) > 0))`);
    }
    return clauses.join(" AND ");
  }

  /** Whether retained narrative can satisfy the item-level filters, which it has no facts for. */
  private retainedEligible(query: HistoryQuery) {
    return !query.harness && !query.turn && query.since === null && query.until === null && !query.phase && !query.tool && !query.file;
  }

  private coverage(query: HistoryQuery): Coverage {
    const bindings: Bindings = {};
    // Coverage describes selected threads, not merely matching items.
    const where = this.filters({ ...query, action: "threads", since: null, until: null }, bindings);
    return this.database.prepare(`WITH selected AS (SELECT th.id FROM workbench_threads th
      LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id WHERE ${where})
      SELECT (SELECT COUNT(*) FROM selected) AS threads,
      (SELECT COUNT(*) FROM thread_turns WHERE thread_id IN (SELECT id FROM selected)) AS turns,
      (SELECT COUNT(*) FROM thread_turn_materializations WHERE thread_id IN (SELECT id FROM selected)) AS materializedTurns,
      (SELECT COUNT(*) FROM thread_turn_payload_retention r JOIN thread_turns t ON t.id = r.turn_id
        WHERE t.thread_id IN (SELECT id FROM selected)) AS expiredTurns,
      (SELECT COUNT(*) FROM thread_items WHERE thread_id IN (SELECT id FROM selected)) AS items`).get(bindings) as Coverage;
  }

  private stats(query: HistoryQuery, coverage: Coverage): HistoryPage {
    const bindings: Bindings = {};
    const where = this.filters(query, bindings, true);
    const groups = this.database.prepare(`SELECT ${historyKindSql} AS kind, COUNT(*) AS count ${itemJoins} WHERE ${where} GROUP BY kind`).all(bindings) as { kind: string; count: number }[];
    return this.page(coverage, { rows: [{ kind: "stats", id: "coverage", threadId: query.threads[0] ?? null,
      turnId: null, projectId: query.project, title: "Stored transcript coverage", createdAt: null, fields: [],
      counts: { ...coverage, ...Object.fromEntries(groups.map(row => [`kind.${row.kind}`, row.count])) } }] });
  }

  /** Title matching for the threads catalogue: every positive clause as folded text, none of the excluded ones. */
  private titlePredicate(query: HistoryQuery, bindings: Bindings) {
    const clauses = query.query ? parseSearchQuery(query.query) : [];
    return ["1", ...clauses.map((clause, index) => {
      bindings[`title${index}`] = clause.value;
      return `${clause.excluded ? "NOT " : ""}(instr(wb_transcript_fold(th.title), @title${index}) > 0)`;
    })].join(" AND ");
  }

  private catalog(query: HistoryQuery, cursor: Cursor, coverage: Coverage): HistoryPage {
    const bindings: Bindings = { ceiling: cursor.ceiling, offset: cursor.offset, limit: query.limit + 1 };
    const where = this.filters(query, bindings);
    let rows: HistoryRow[];
    if (query.action === "projects") {
      const values = this.database.prepare(`SELECT th.project_id AS id, th.project_root AS root, COUNT(*) AS count
        FROM workbench_threads th LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE th.rowid <= @ceiling AND ${where} GROUP BY th.project_id, th.project_root ORDER BY th.project_id, th.project_root LIMIT @limit OFFSET @offset`).all(bindings) as { id: string; root: string; count: number }[];
      rows = values.map(row => ({ kind: "project", id: row.id, threadId: null, turnId: null, projectId: row.id, title: row.root,
        createdAt: null, fields: [], counts: { threads: row.count } }));
    } else if (query.action === "turns") {
      const values = this.database.prepare(`SELECT tr.id, tr.thread_id AS threadId, tr.turn_index AS turnIndex, tr.state,
        tr.harness_id AS harness, tr.created_at AS createdAt, tr.started_at AS startedAt, tr.ended_at AS endedAt,
        EXISTS(SELECT 1 FROM thread_turn_materializations m WHERE m.turn_id = tr.id) AS materialized
        FROM thread_turns tr JOIN workbench_threads th ON th.id = tr.thread_id
        LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE tr.rowid <= @ceiling AND ${where} ORDER BY tr.turn_index DESC LIMIT @limit OFFSET @offset`).all(bindings) as { id: string; threadId: string; turnIndex: number; state: string; harness: string; createdAt: number; startedAt: number | null; endedAt: number | null; materialized: number }[];
      rows = values.map(row => ({ kind: "turn", id: row.id, threadId: row.threadId, turnId: row.id, projectId: null,
        title: `${row.state} (${row.harness})`, createdAt: row.createdAt,
        fields: [displayField("startedAt", row.startedAt), displayField("endedAt", row.endedAt)],
        counts: { turnIndex: row.turnIndex, materialized: row.materialized } }));
    } else {
      const matching = this.titlePredicate(query, bindings);
      const values = this.database.prepare(`SELECT th.id, th.project_id AS projectId, th.title, th.activity_at AS createdAt,
        ${archivedPlacement} AS archived, COALESCE(lc.settled, 0) AS settled
        FROM workbench_threads th LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE th.rowid <= @ceiling AND ${where} AND ${matching} ORDER BY th.activity_at DESC, th.id LIMIT @limit OFFSET @offset`).all(bindings) as { id: string; projectId: string; title: string; createdAt: number; archived: number; settled: number }[];
      rows = values.map(row => ({ kind: "thread", id: row.id, threadId: row.id, turnId: null, projectId: row.projectId,
        title: row.title.slice(0, 300), createdAt: row.createdAt, fields: [], counts: { archived: row.archived, settled: row.settled } }));
    }
    const more = rows.length > query.limit;
    rows = rows.slice(0, query.limit);
    return this.page(coverage, { rows, nextCursor: more ? encode({ ...cursor, offset: cursor.offset + rows.length }) : null });
  }

  private selectItems(query: HistoryQuery, where: string) {
    return `SELECT i.id, i.public_id AS publicId, i.thread_id AS threadId,
      i.turn_id AS turnId, th.project_id AS projectId, th.title, ${historyKindSql} AS kind,
      i.created_at AS createdAt, ${query.threads.length === 1 ? "0" : "tr.created_at"} AS ordTime,
      tr.turn_index AS turnIndex, i.item_position AS position, tr.harness_id AS harness, u.input_kind AS inputKind
      ${itemJoins} WHERE ${where}`;
  }

  private locate(query: HistoryQuery, item: string): ItemRow {
    const bindings: Bindings = { item };
    const where = this.filters({ ...query, view: "items", kinds: [] }, bindings, true);
    const row = this.database.prepare(this.selectItems(query, `${where} AND i.public_id = @item`)).get(bindings) as ItemRow | undefined;
    if (!row) throw new HistoryQueryError("Unknown item in the selected Workbench thread. A retention-expired item needs its turn recovered first.");
    return row;
  }

  /** Stored items next to a position in one direction, nearest first, in canonical order rather than by timestamps. */
  private *walkItems(query: HistoryQuery, direction: Direction, from: ItemRow | null): Generator<ItemRow> {
    const bindings: Bindings = {};
    const base = this.filters(query, bindings, true);
    const time = query.threads.length === 1 ? "0" : "tr.created_at";
    const order = direction === "older" ? "DESC" : "ASC";
    const comparison = direction === "older" ? "<" : ">";
    let last = from;
    for (;;) {
      const where = last
        ? `${base} AND (${time}, i.thread_id, tr.turn_index, i.item_position, i.id) ${comparison} (@ordTime, @threadId, @turnIndex, @position, @id)`
        : base;
      const batch = this.database.prepare(`${this.selectItems(query, where)}
        ORDER BY ordTime ${order}, threadId ${order}, turnIndex ${order}, position ${order}, i.id ${order} LIMIT ${BATCH_SIZE}`)
        .all(last ? { ...bindings, ordTime: last.ordTime, threadId: last.threadId, turnIndex: last.turnIndex, position: last.position, id: last.id } : bindings) as ItemRow[];
      yield* batch;
      if (batch.length < BATCH_SIZE) return;
      last = batch.at(-1)!;
    }
  }

  private projected(rows: readonly { id: number; threadId: string }[], opaque: boolean) {
    const items = new Map<number, WorkbenchProjectedTranscriptItem>();
    const repository = new WorkbenchTranscriptRepository(this.database);
    for (const threadId of new Set(rows.map(row => row.threadId))) {
      const projection = repository.readStoredItems(threadId, rows.filter(row => row.threadId === threadId).map(row => row.id));
      if ("issues" in projection) {
        throw new Error(`Stored transcript projection failed: ${projection.issues.map(issue => `${issue.code} in ${issue.table}`).join(", ").slice(0, 500)}`);
      }
      for (const { root, item } of projection.data) items.set(root.id, item);
    }
    return new Map([...items].map(([id, item]) => [id, transcriptItemFields(item, opaque)]));
  }

  private readItems(query: HistoryQuery, coverage: Coverage): HistoryPage {
    const anchorRef = query.before ?? query.after ?? query.around;
    const anchor = anchorRef ? this.locate(query, readHistoryAnchor(anchorRef).itemId) : null;
    const take = (direction: Direction, count: number) => {
      const rows: ItemRow[] = [];
      let more = false;
      for (const row of this.walkItems(query, direction, anchor)) {
        if (rows.length === count) { more = true; break; }
        rows.push(row);
      }
      return { rows, more };
    };
    let rows: ItemRow[];
    let older = false;
    let newer = false;
    if (query.around) {
      const before = take("older", query.context);
      const after = take("newer", query.context);
      rows = [...before.rows.reverse(), anchor!, ...after.rows];
      ({ more: older } = before);
      ({ more: newer } = after);
    } else if (query.after) {
      const after = take("newer", query.limit);
      rows = after.rows;
      older = true;
      newer = after.more;
    } else {
      const before = take("older", query.limit);
      rows = before.rows.reverse();
      older = before.more;
      newer = anchor !== null;
    }
    const fields = this.projected(rows, query.opaque);
    return this.page(coverage, {
      rows: rows.map(row => entry(row, previewTranscriptFields(fields.get(row.id)!))),
      older, newer,
      ...(query.threads.length === 1 ? this.gaps(query.threads[0]!, rows.map(row => row.turnIndex), anchor?.turnIndex ?? null, { older, newer, query }) : {}),
    });
  }

  /**
   * Turns inside a read window whose stored items are missing, split by cause: never materialised, or
   * retention-expired with nothing recovered. The window reaches the thread's ends whenever no stored history lies beyond it.
   */
  private gaps(threadId: string, turnIndexes: readonly number[], anchorTurn: number | null, { older, newer, query }: { older: boolean; newer: boolean; query: HistoryQuery }) {
    const known = anchorTurn === null ? turnIndexes : [...turnIndexes, anchorTurn];
    const low = query.after ? anchorTurn! : older && known.length ? Math.min(...known) : -1;
    const high = query.before ? anchorTurn! : newer && known.length ? Math.max(...known) : Number.MAX_SAFE_INTEGER;
    const select = (condition: string) => this.database.prepare(`SELECT tr.id FROM thread_turns tr
      WHERE tr.thread_id = ? AND tr.turn_index BETWEEN ? AND ? AND ${condition}
      ORDER BY tr.turn_index DESC LIMIT ${MAX_GAPS}`).pluck().all(threadId, low, high) as string[];
    return {
      gaps: select("NOT EXISTS (SELECT 1 FROM thread_turn_materializations m WHERE m.turn_id = tr.id)"),
      expired: select(`EXISTS (SELECT 1 FROM thread_turn_payload_retention r WHERE r.turn_id = tr.id)
        AND NOT EXISTS (SELECT 1 FROM thread_items i WHERE i.turn_id = tr.id)`),
    };
  }

  /** Live narrative-capable items and placeable retained narrative of one thread, as one ordered source. */
  private narrativeSource() {
    return `SELECT i.id AS key, i.public_id AS publicId, i.turn_id AS turnId, tr.turn_index AS turnIndex,
        i.item_position AS position, tr.harness_id AS harness, u.input_kind AS inputKind, NULL AS role, NULL AS text
      FROM thread_items i JOIN thread_turns tr ON tr.id = i.turn_id
      LEFT JOIN thread_item_user_messages u ON u.item_id = i.id
      WHERE i.thread_id = @thread AND (@turn IS NULL OR i.turn_id = @turn) AND ${narrativeTypes}
      UNION ALL
      SELECT -r.id, r.item_public_id, tr.id, tr.turn_index, r.id, tr.harness_id, NULL, r.role, r.text
      FROM workbench_search_narratives r JOIN thread_turns tr ON tr.id = ${retainedTurn}
      WHERE r.thread_id = @thread AND (@turn IS NULL OR tr.id = @turn) AND NOT ${liveCopy}`;
  }

  private locateNarrative(query: HistoryQuery, itemId: string) {
    const row = this.database.prepare(`SELECT * FROM (${this.narrativeSource()}) WHERE publicId = @item`)
      .get({ thread: query.threads[0]!, turn: query.turn, item: itemId }) as NarrativeRow | undefined;
    if (!row) throw new HistoryQueryError("Unknown record in the selected Workbench thread. A retention-expired item needs its turn recovered first.");
    return row;
  }

  private *walkNarrative(query: HistoryQuery, direction: Direction, from: Position | null): Generator<NarrativeRow> {
    const order = direction === "older" ? "DESC" : "ASC";
    let last = from;
    for (;;) {
      const batch = this.database.prepare(`SELECT * FROM (${this.narrativeSource()})
        ${last ? `WHERE (turnIndex, position, key) ${direction === "older" ? "<" : ">"} (@turnIndex, @position, @key)` : ""}
        ORDER BY turnIndex ${order}, position ${order}, key ${order} LIMIT ${BATCH_SIZE}`)
        .all({ thread: query.threads[0]!, turn: query.turn, ...(last ? { turnIndex: last[0], position: last[1], key: last[2] } : {}) }) as NarrativeRow[];
      yield* batch;
      if (batch.length < BATCH_SIZE) return;
      const tail = batch.at(-1)!;
      last = [tail.turnIndex, tail.position, tail.key];
    }
  }

  /** Records of narrative rows in their given order; projection and turn-opening facts are read in one pass. */
  private narrativeRecordsOf(threadId: string, rows: readonly NarrativeRow[], kinds: ReadonlySet<HistoryNarrativeKind>) {
    const live = rows.filter(row => row.key > 0);
    const items = new Map<number, WorkbenchProjectedTranscriptItem>();
    const repository = new WorkbenchTranscriptRepository(this.database);
    const project = (ids: number[]) => {
      if (!ids.length) return [];
      const projection = repository.readStoredItems(threadId, ids);
      if ("issues" in projection) {
        throw new Error(`Stored transcript projection failed: ${projection.issues.map(issue => `${issue.code} in ${issue.table}`).join(", ").slice(0, 500)}`);
      }
      return projection.data;
    };
    for (const { root, item } of project(live.map(row => row.key))) items.set(root.id, item);
    const openers = new Map<string, string | null>();
    const userTurns = [...new Set(live.filter(row => items.get(row.key)?.type === "userMessage").map(row => row.turnId))];
    for (const turnId of userTurns) {
      const ids = this.database.prepare("SELECT id FROM thread_items WHERE turn_id = ? AND type = 'userMessage' ORDER BY item_position, id").pluck().all(turnId) as number[];
      const opener = project(ids).find(({ item }) => isNarrativeUserMessage(item));
      openers.set(turnId, opener?.root.public_id ?? null);
    }
    return new Map(rows.map((row): [number, HistoryRecord[]] => {
      if (row.key < 0) {
        const record = retainedNarrativeRecord({ itemId: row.publicId, threadId, turnId: row.turnId, role: row.role!, text: row.text ?? "" }, kinds);
        return [row.key, record ? [record] : []];
      }
      const item = items.get(row.key);
      return [row.key, item ? narrativeRecords({
        harness: row.harness, inputKind: row.inputKind, item, opensTurn: openers.get(row.turnId) === row.publicId,
        publicId: row.publicId, threadId, turnId: row.turnId,
      }, kinds) : []];
    }));
  }

  /**
   * Gather records walking one way until `enough` holds, then report whether any further record exists.
   * Returned records are nearest-first.
   */
  private gatherNarrative(query: HistoryQuery, direction: Direction, from: Position | null, kinds: ReadonlySet<HistoryNarrativeKind>, enough: (records: readonly HistoryRecord[]) => boolean) {
    const threadId = query.threads[0]!;
    const records: HistoryRecord[] = [];
    const turns: number[] = [];
    let batch: NarrativeRow[] = [];
    let satisfied = false;
    const flush = () => {
      const byKey = this.narrativeRecordsOf(threadId, batch, kinds);
      for (const row of batch) {
        const own = byKey.get(row.key) ?? [];
        if (!own.length) continue;
        if (satisfied) return true;
        // Derived plan records follow their message; walking older reverses them with everything else.
        records.push(...(direction === "older" ? [...own].reverse() : own));
        turns.push(row.turnIndex);
        satisfied = enough(records);
      }
      batch = [];
      return false;
    };
    for (const row of this.walkNarrative(query, direction, from)) {
      batch.push(row);
      if (batch.length === BATCH_SIZE && flush()) return { records, turns, more: true };
    }
    return { records, turns, more: flush() };
  }

  private readNarrative(query: HistoryQuery, coverage: Coverage): HistoryPage {
    const kinds = narrativeKinds(query);
    const anchorRef = query.before ?? query.after ?? query.around;
    const anchor = anchorRef ? readHistoryAnchor(anchorRef) : null;
    const anchorRow = anchor ? this.locateNarrative(query, anchor.itemId) : null;
    const position: Position | null = anchorRow ? [anchorRow.turnIndex, anchorRow.position, anchorRow.key] : null;
    const own = anchorRow ? this.narrativeRecordsOf(query.threads[0]!, [anchorRow], kinds).get(anchorRow.key) ?? [] : [];
    const byText = (limit: number) => (records: readonly HistoryRecord[]) => records.reduce((sum, record) => sum + record.text.length, 0) >= limit;
    // A `ref@offset` continuation re-reads the split record; the front-end shows only its unshown side.
    const split = anchor && anchor.offset !== null ? own.findIndex(record => record.ref === (anchor.part ? `${anchor.itemId}:${anchor.part}` : anchor.itemId)) : -1;
    const inclusive = split < 0 ? [] : query.after ? own.slice(split) : own.slice(0, split + 1);
    let records: HistoryRecord[];
    let older = false;
    let newer = false;
    let turns: number[] = [];
    if (query.around) {
      const before = this.gatherNarrative(query, "older", position, kinds, records => records.length >= query.context);
      const after = this.gatherNarrative(query, "newer", position, kinds, records => records.length >= query.context);
      records = [...before.records.reverse(), ...own, ...after.records];
      ({ more: older } = before);
      ({ more: newer } = after);
      turns = [...before.turns, ...after.turns];
    } else if (query.after) {
      const after = this.gatherNarrative(query, "newer", position, kinds, byText(Math.max(0, NARRATIVE_WINDOW_CHARACTERS - (inclusive[0]?.text.length ?? 0))));
      records = [...inclusive, ...after.records];
      older = true;
      newer = after.more;
      turns = after.turns;
    } else {
      const before = this.gatherNarrative(query, "older", position, kinds, byText(Math.max(0, NARRATIVE_WINDOW_CHARACTERS - (inclusive[0]?.text.length ?? 0))));
      records = [...before.records.reverse(), ...inclusive];
      older = before.more;
      newer = anchorRow !== null;
      turns = before.turns;
    }
    return this.page(coverage, {
      records, older, newer,
      ...this.gaps(query.threads[0]!, turns, anchorRow?.turnIndex ?? null, { older, newer, query }),
    });
  }

  private show(query: HistoryQuery, cursor: Cursor, coverage: Coverage): HistoryPage {
    const row = this.locate(query, query.item!);
    const fields = this.projected([row], query.opaque).get(row.id)!;
    const revision = digest(JSON.stringify(fields));
    if (cursor.revision && cursor.revision !== revision) throw new HistoryQueryError("Item changed since this expansion cursor. Read the item again.");
    const expanded = expandTranscriptFields(fields, cursor.field ?? 0, cursor.fieldOffset);
    const nextCursor = expanded.next
      ? encode({ ...cursor, field: expanded.next.index, fieldOffset: expanded.next.offset, revision }) : null;
    return this.page(coverage, { rows: [entry(row, expanded.fields)], nextCursor });
  }

  /** Index hits of one clause: the clause itself, identifier words containing it, else its nearest spellings. */
  /**
   * The best-ranked in-scope documents for one expression, plus a native count of all of them. Scope, exclusions and the
   * cap all apply inside SQLite, so broad terms never materialise as JS rows.
   */
  private scopedHits(query: HistoryQuery, expression: string, exclusion: string | null, ceiling: number) {
    const bindings: Bindings = {
      ceiling,
      expression: historyItemExpression(expression, query.opaque),
      ...(exclusion ? { exclusion: historyItemExpression(exclusion, query.opaque) } : {}),
    };
    const kept = exclusion ? "AND hits.key NOT IN (SELECT rowid FROM history_index WHERE history_index MATCH @exclusion)" : "";
    const live = `SELECT hits.key, hits.rank ${itemJoins.replace("FROM thread_items i", "FROM hits JOIN thread_items i ON i.id = hits.key")}
      WHERE i.id <= @ceiling AND ${this.filters(query, bindings, true)} ${kept}`;
    const retained = this.retainedEligible(query)
      ? `UNION ALL SELECT hits.key, hits.rank FROM hits JOIN workbench_search_narratives r ON r.id = -hits.key
        JOIN workbench_threads th ON th.id = r.thread_id LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE ${this.filters({ ...query, action: "threads" }, bindings)} AND NOT ${liveCopy} ${kept}`
      : "";
    const scoped = `WITH hits AS MATERIALIZED (SELECT rowid AS key, rank FROM history_index WHERE history_index MATCH @expression)
      SELECT key, rank FROM (${live} ${retained})`;
    const hits = this.database.prepare(`${scoped} ORDER BY rank LIMIT ${MAX_HITS_PER_TERM}`).all(bindings) as Array<{ key: number; rank: number }>;
    const total = this.database.prepare(`SELECT COUNT(*) FROM (${scoped})`).pluck().get(bindings) as number;
    return { hits: new Map(hits.map(hit => [hit.key, hit.rank])), total };
  }

  /** One clause's expression: itself plus identifier words containing it, or its nearest spellings when it matches nothing. */
  private clauseExpression(clause: SearchClause, corrections: HistorySearchSummary["corrections"], needles: string[]) {
    const index = this.requireIndex();
    const expression = historyClauseExpression(clause)!;
    const fragment = clause.tokens.join("");
    const containing = clause.kind === "word" && fragment.length >= 4 ? index.vocabularyContaining(fragment, { limit: MAX_IDENTIFIER_TERMS }) : [];
    const widened = containing.length ? `(${expression}) OR ${historyAnyOf(containing)}` : expression;
    if (clause.kind !== "word" || clause.tokens.length !== 1 || this.database.prepare(
      "SELECT 1 FROM history_index WHERE history_index MATCH ? LIMIT 1",
    ).get(widened)) return widened;
    const nearby = searchCorrections(clause.value, index.vocabularyNear(clause.value));
    if (!nearby.length) return widened;
    corrections.push({ from: clause.value, to: nearby[0]! });
    needles.push(...nearby);
    return historyAnyOf(nearby);
  }

  /** Metadata for capped candidates; keys are item ids or negated retained ids. */
  private scopeCandidates(query: HistoryQuery, keys: readonly number[]) {
    const live = keys.filter(key => key > 0);
    const retained = keys.filter(key => key < 0).map(key => -key);
    const bindings: Bindings = { live: JSON.stringify(live) };
    const where = this.filters(query, bindings, true);
    const items = this.database.prepare(this.selectItems(query, `i.id IN (SELECT value FROM json_each(@live)) AND ${where}`)).all(bindings) as ItemRow[];
    const scoped = new Map<number, ItemRow | (ItemRow & { role: "assistant" | "user"; text: string })>(items.map(row => [row.id, row]));
    if (retained.length && this.retainedEligible(query)) {
      const threadBindings: Bindings = { retained: JSON.stringify(retained) };
      const threadWhere = this.filters({ ...query, action: "threads" }, threadBindings);
      const rows = this.database.prepare(`SELECT -r.id AS id, r.item_public_id AS publicId, r.thread_id AS threadId,
          ${retainedTurn} AS turnId, th.project_id AS projectId, th.title, r.role, r.text,
          CASE r.role WHEN 'user' THEN 'user-message' ELSE 'commentary' END AS kind, th.activity_at AS createdAt,
          0 AS ordTime, -1 AS turnIndex, r.id AS position, '' AS harness, NULL AS inputKind
        FROM workbench_search_narratives r JOIN workbench_threads th ON th.id = r.thread_id
        LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE r.id IN (SELECT value FROM json_each(@retained)) AND ${threadWhere} AND NOT ${liveCopy}`)
        .all(threadBindings) as Array<ItemRow & { role: "assistant" | "user"; text: string }>;
      for (const row of rows) {
        if (!query.kinds.length || (query.kinds as string[]).includes(row.kind)) scoped.set(row.id, row);
      }
    }
    return scoped;
  }

  private search(query: HistoryQuery, cursor: Cursor, coverage: Coverage): HistoryPage {
    const clauses = parseSearchQuery(query.query!);
    const positives = clauses.filter(clause => !clause.excluded && historyClauseExpression(clause));
    if (!positives.length) throw new HistoryQueryError("--query needs at least one included word of two or more characters, or a quoted phrase.");
    const index = this.requireIndex();
    const corrections: HistorySearchSummary["corrections"] = [];
    const needles = positives.flatMap(clause => [clause.value, ...clause.tokens]);
    const expressions = positives.map(clause => this.clauseExpression(clause, corrections, needles));
    const exclusions = clauses.filter(clause => clause.excluded).flatMap(clause => historyClauseExpression(clause) ?? []);
    const exclusion = exclusions.length ? exclusions.map(expression => `(${expression})`).join(" OR ") : null;
    const perClause = expressions.map(expression => this.scopedHits(query, expression, exclusion, cursor.ceiling));
    // Items holding every clause rank first even when no single clause ranked them in its top hits.
    const all = expressions.length > 1
      ? this.scopedHits(query, expressions.map(expression => `(${expression})`).join(" AND "), exclusion, cursor.ceiling)
      : perClause[0]!;
    const any = expressions.length > 1
      ? this.scopedHits(query, expressions.map(expression => `(${expression})`).join(" OR "), exclusion, cursor.ceiling).total
      : all.total;
    const scoped = this.scopeCandidates(query, [...new Set([...all.hits.keys(), ...perClause.flatMap(clause => [...clause.hits.keys()])])]);
    const ranked = [...scoped.values()].flatMap(row => {
      const together = all.hits.get(row.id);
      if (together !== undefined) return [{ row, matched: positives.length, quality: searchBodyQuality(together) }];
      let matched = 0;
      let quality = 0;
      for (const [index, clause] of positives.entries()) {
        const rank = perClause[index]!.hits.get(row.id);
        if (rank === undefined) {
          if (clause.kind === "phrase") return [];
          continue;
        }
        matched += 1;
        quality += searchBodyQuality(rank);
      }
      return [{ row, matched, quality: quality / positives.length }];
    }).sort((left, right) => right.matched - left.matched || right.quality - left.quality
      || right.row.ordTime - left.row.ordTime || right.row.turnIndex - left.row.turnIndex
      || right.row.position - left.row.position || right.row.id - left.row.id);
    const summary: HistorySearchSummary = {
      complete: all.total,
      partial: any - all.total,
      terms: positives.map((clause, index) => ({
        term: clause.kind === "phrase" ? `"${clause.value}"` : clause.value,
        hits: perClause[index]!.total,
      })),
      corrections,
      indexed: index.progress(),
    };
    const phrases = exactPhrases(positives);
    const kinds = narrativeKinds(query);
    const rows: HistoryRow[] = [];
    const records: HistoryRecord[] = [];
    let consumed = cursor.offset;
    let projected = 0;
    const full = () => (query.view === "narrative" ? records.length : rows.length) >= query.limit;
    while (consumed < ranked.length && !full() && projected < MAX_SEARCH_PROJECTIONS) {
      const chunk = ranked.slice(consumed, consumed + query.limit * 2).map(entry => entry.row);
      projected += chunk.length;
      if (query.view === "narrative") {
        const byKey = this.narrativeRecordsOfSearch(query.threads[0]!, chunk, kinds);
        for (const row of chunk) {
          consumed += 1;
          const record = byKey.get(row.id);
          if (record && holdsPhrases(record.text, phrases)) records.push({ ...record, excerpt: searchExcerpt(record.text, needles, 500) });
          if (full()) break;
        }
      } else {
        const fields = this.projected(chunk.filter(row => row.id > 0), query.opaque);
        for (const row of chunk) {
          consumed += 1;
          const own = row.id > 0 ? fields.get(row.id)! : [displayField("text", (row as ItemRow & { text: string }).text)];
          const text = fieldText(own);
          if (holdsPhrases(text, phrases)) rows.push({ ...entry(row, previewTranscriptFields(own)), excerpt: searchExcerpt(text, needles) });
          if (full()) break;
        }
      }
    }
    return this.page(coverage, {
      rows, records, search: summary,
      nextCursor: consumed < ranked.length ? encode({ ...cursor, offset: consumed }) : null,
    });
  }

  /** The one record a narrative search hit shows: its message, or its first plan when only plans are selected. */
  private narrativeRecordsOfSearch(threadId: string, rows: readonly ItemRow[], kinds: ReadonlySet<HistoryNarrativeKind>) {
    const narrativeRows = rows.map((row): NarrativeRow => ({
      harness: row.harness, inputKind: row.inputKind, key: row.id, position: row.position, publicId: row.publicId,
      role: "role" in row ? row.role as NarrativeRow["role"] : null, text: "text" in row ? row.text as string : null,
      turnId: row.turnId, turnIndex: row.turnIndex,
    }));
    const byKey = this.narrativeRecordsOf(threadId, narrativeRows, kinds);
    return new Map(rows.flatMap(row => {
      const first = byKey.get(row.id)?.[0];
      return first ? [[row.id, first] as const] : [];
    }));
  }
}
