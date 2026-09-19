/*
 * Exports:
 * - default WorkbenchTranscriptQueryRepository: query stored canonical transcript rows without materialisation.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { TranscriptQueryError, type TranscriptField, type TranscriptQuery, type TranscriptQueryPage, type TranscriptQueryRow } from "./transcript-query-contract.ts";
import { transcriptQueryFieldsSql, transcriptQueryKindSql } from "./transcript-query-fields.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import { expandTranscriptFields, previewTranscriptFields, transcriptItemFields } from "./transcript-item-data.ts";

const positionSchema = z.tuple([z.number(), z.string(), z.number(), z.number(), z.number()]);
const cursorSchema = z.object({
  version: z.literal(1), signature: z.string(), ceiling: z.number().int().nonnegative(),
  position: positionSchema.nullable(), offset: z.number().int().nonnegative(),
  field: z.number().int().nonnegative().nullable(), fieldOffset: z.number().int().nonnegative(), revision: z.string().nullable(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
type Bindings = Record<string, string | number | null>;
interface ItemRow {
  id: number; publicId: string; threadId: string; turnId: string; projectId: string;
  title: string; kind: string; createdAt: number; ordTime: number; turnIndex: number; position: number;
}
const BATCH_SIZE = 200;
const itemJoins = `FROM thread_items i
  JOIN thread_turns tr ON tr.id = i.turn_id
  JOIN workbench_threads th ON th.id = i.thread_id
  LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
  LEFT JOIN thread_item_user_messages u ON u.item_id = i.id
  LEFT JOIN thread_item_assistant_messages a ON a.item_id = i.id
  LEFT JOIN thread_operation_process_sources p ON p.item_id = i.id
  LEFT JOIN thread_operation_tool_sources t ON t.item_id = i.id`;

function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }
function signature(query: TranscriptQuery) {
  const { cursor: _cursor, json: _json, limit: _limit, ...selection } = query;
  return digest(JSON.stringify(selection));
}
function encode(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function itemPosition(row: ItemRow): z.infer<typeof positionSchema> { return [row.ordTime, row.threadId, row.turnIndex, row.position, row.id]; }
function entry(row: ItemRow, fields: TranscriptField[]): TranscriptQueryRow {
  return { id: row.publicId, threadId: row.threadId, turnId: row.turnId, projectId: row.projectId,
    title: row.title.slice(0, 300), kind: row.kind, createdAt: row.createdAt, fields, counts: {} };
}
function displayField(name: string, value: TranscriptField["value"]): TranscriptField { return { path: [name], value }; }

export default class WorkbenchTranscriptQueryRepository {
  constructor(private readonly database: Database.Database) {
    // SQLite's built-in lower() only folds ASCII. Keep literal matching Unicode-aware.
    database.function("wb_transcript_fold", { deterministic: true }, (value: string) => value.toLowerCase());
  }

  read(query: TranscriptQuery): TranscriptQueryPage {
    return this.database.transaction(() => this.readTransaction(query))();
  }

  private readTransaction(query: TranscriptQuery): TranscriptQueryPage {
    for (const id of query.threads) {
      if (!this.database.prepare("SELECT 1 FROM workbench_threads WHERE id = ?").get(id)) throw new TranscriptQueryError(`Unknown Workbench thread: ${id}`);
    }
    if (query.turn && !this.database.prepare(`SELECT 1 FROM thread_turns WHERE id = ? AND thread_id IN (${query.threads.map(() => "?").join(",")})`).get(query.turn, ...query.threads)) {
      throw new TranscriptQueryError("Unknown turn in the selected Workbench thread.");
    }
    const cursor = this.cursor(query);
    const coverage = this.coverage(query);
    if (query.action === "stats") {
      const bindings: Bindings = {};
      const where = this.filters(query, bindings, true);
      const groups = this.database.prepare(`SELECT ${transcriptQueryKindSql} AS kind, COUNT(*) AS count ${itemJoins} WHERE ${where} GROUP BY kind`).all(bindings) as { kind: string; count: number }[];
      return { coverage, scanned: 0, nextCursor: null, rows: [{ kind: "stats", id: "coverage", threadId: query.threads[0] ?? null,
        turnId: null, projectId: query.project, title: "Stored transcript coverage", createdAt: null, fields: [],
        counts: { ...coverage, ...Object.fromEntries(groups.map(row => [`kind.${row.kind}`, row.count])) } }] };
    }
    if (["projects", "threads", "turns"].includes(query.action)) return this.catalog(query, cursor, coverage);
    if (query.action === "show") return this.show(query, cursor, coverage);
    return this.items(query, cursor, coverage);
  }

  private cursor(query: TranscriptQuery): Cursor {
    if (query.cursor) {
      try {
        const value = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
        if (value.signature !== signature(query)) throw new TranscriptQueryError("Cursor belongs to different transcript filters.");
        return value;
      } catch (error) {
        if (error instanceof TranscriptQueryError) throw error;
        throw new TranscriptQueryError("Invalid transcript cursor.");
      }
    }
    const table = ["projects", "threads"].includes(query.action) ? "workbench_threads" : query.action === "turns" ? "thread_turns" : "thread_items";
    const { ceiling } = this.database.prepare(`SELECT COALESCE(MAX(rowid), 0) AS ceiling FROM ${table}`).get() as { ceiling: number };
    return { version: 1, signature: signature(query), ceiling, position: null, offset: 0, field: null, fieldOffset: 0, revision: null };
  }

  private filters(query: TranscriptQuery, bindings: Bindings, items = false) {
    const clauses = ["1"];
    const bind = (key: string, value: string | number) => { bindings[key] = value; return `@${key}`; };
    if (query.threads.length) clauses.push(`th.id IN (${query.threads.map((value, index) => bind(`thread${index}`, value)).join(",")})`);
    if (query.project) clauses.push(`th.project_id = ${bind("project", query.project)}`);
    if (query.archived !== null) clauses.push(`th.archived = ${bind("archived", Number(query.archived))}`);
    if (query.settled !== null) clauses.push(`COALESCE(lc.settled, 0) = ${bind("settled", Number(query.settled))}`);
    if (query.harness) clauses.push(items || query.action === "turns"
      ? `tr.harness_id = ${bind("harness", query.harness)}`
      : `EXISTS (SELECT 1 FROM thread_turns ht WHERE ht.thread_id = th.id AND ht.harness_id = ${bind("harness", query.harness)})`);
    if (query.turn && (items || query.action === "turns")) clauses.push(`tr.id = ${bind("turn", query.turn)}`);
    const time = items ? "i.created_at" : query.action === "turns" ? "tr.created_at" : "th.activity_at";
    if (query.since !== null) clauses.push(`${time} >= ${bind("since", query.since)}`);
    if (query.until !== null) clauses.push(`${time} <= ${bind("until", query.until)}`);
    if (items) {
      if (query.kinds.length) clauses.push(`(${transcriptQueryKindSql}) IN (${query.kinds.map((value, index) => bind(`kind${index}`, value)).join(",")})`);
      if (query.phase) clauses.push(`a.phase = ${bind("phase", query.phase)}`);
      if (query.tool) clauses.push(`(t.tool_name = ${bind("tool", query.tool)} OR EXISTS (SELECT 1 FROM thread_item_tool_outputs o WHERE o.item_id = i.id AND o.name = @tool))`);
      if (query.file) clauses.push(`EXISTS (SELECT 1 FROM thread_file_changes f WHERE f.item_id = i.id AND (instr(f.path, ${bind("file", query.file)}) > 0 OR instr(COALESCE(f.move_path, ''), @file) > 0))`);
    }
    return clauses.join(" AND ");
  }

  private coverage(query: TranscriptQuery): TranscriptQueryPage["coverage"] {
    const bindings: Bindings = {};
    // Coverage describes selected threads, not merely matching items.
    const where = this.filters({ ...query, action: "threads", since: null, until: null }, bindings);
    return this.database.prepare(`WITH selected AS (SELECT th.id FROM workbench_threads th
      LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id WHERE ${where})
      SELECT (SELECT COUNT(*) FROM selected) AS threads,
      (SELECT COUNT(*) FROM thread_turns WHERE thread_id IN (SELECT id FROM selected)) AS turns,
      (SELECT COUNT(*) FROM thread_turn_materializations WHERE thread_id IN (SELECT id FROM selected)) AS materializedTurns,
      (SELECT COUNT(*) FROM thread_items WHERE thread_id IN (SELECT id FROM selected)) AS items`).get(bindings) as TranscriptQueryPage["coverage"];
  }

  private textPredicate(expression: string, query: TranscriptQuery, bindings: Bindings) {
    const folded = query.caseSensitive ? expression : `wb_transcript_fold(${expression})`;
    const term = (value: string, key: string) => {
      bindings[key] = query.caseSensitive ? value : value.toLowerCase();
      return `instr(${folded}, @${key}) > 0`;
    };
    const include = query.queries.map((value, index) => term(value, `query${index}`));
    const exclude = query.excludes.map((value, index) => `NOT (${term(value, `exclude${index}`)})`);
    return [`(${include.join(query.any ? " OR " : " AND ") || "1"})`, ...exclude].join(" AND ");
  }

  private catalog(query: TranscriptQuery, cursor: Cursor, coverage: TranscriptQueryPage["coverage"]): TranscriptQueryPage {
    const bindings: Bindings = { ceiling: cursor.ceiling, offset: cursor.offset, limit: query.limit + 1 };
    const where = this.filters(query, bindings);
    let rows: TranscriptQueryRow[];
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
        WHERE tr.rowid <= @ceiling AND ${where} ORDER BY tr.turn_index ${query.direction === "older" ? "DESC" : "ASC"} LIMIT @limit OFFSET @offset`).all(bindings) as { id: string; threadId: string; turnIndex: number; state: string; harness: string; createdAt: number; startedAt: number | null; endedAt: number | null; materialized: number }[];
      rows = values.map(row => ({ kind: "turn", id: row.id, threadId: row.threadId, turnId: row.id, projectId: null,
        title: `${row.state} (${row.harness})`, createdAt: row.createdAt,
        fields: [displayField("startedAt", row.startedAt), displayField("endedAt", row.endedAt)],
        counts: { turnIndex: row.turnIndex, materialized: row.materialized } }));
    } else {
      const matching = this.textPredicate("th.title", query, bindings);
      const values = this.database.prepare(`SELECT th.id, th.project_id AS projectId, th.title, th.activity_at AS createdAt,
        th.archived, COALESCE(lc.settled, 0) AS settled
        FROM workbench_threads th LEFT JOIN workbench_thread_lifecycle lc ON lc.thread_id = th.id
        WHERE th.rowid <= @ceiling AND ${where} AND ${matching} ORDER BY th.activity_at DESC, th.id LIMIT @limit OFFSET @offset`).all(bindings) as { id: string; projectId: string; title: string; createdAt: number; archived: number; settled: number }[];
      rows = values.map(row => ({ kind: "thread", id: row.id, threadId: row.id, turnId: null, projectId: row.projectId,
        title: row.title.slice(0, 300), createdAt: row.createdAt, fields: [], counts: { archived: row.archived, settled: row.settled } }));
    }
    const more = rows.length > query.limit;
    rows = rows.slice(0, query.limit);
    return { rows, coverage, scanned: rows.length, nextCursor: more ? encode({ ...cursor, offset: cursor.offset + rows.length }) : null };
  }

  private selectItems(query: TranscriptQuery, where: string) {
    return `SELECT i.id, i.public_id AS publicId, i.thread_id AS threadId,
      i.turn_id AS turnId, th.project_id AS projectId, th.title, ${transcriptQueryKindSql} AS kind,
      i.created_at AS createdAt, ${query.threads.length === 1 ? "0" : "tr.created_at"} AS ordTime,
      tr.turn_index AS turnIndex, i.item_position AS position ${itemJoins} WHERE ${where}`;
  }

  private locate(query: TranscriptQuery, item: string): ItemRow {
    const bindings: Bindings = { item };
    const where = this.filters(query, bindings, true);
    const row = this.database.prepare(this.selectItems(query, `${where} AND i.public_id = @item`))
      .get(bindings) as ItemRow | undefined;
    if (!row) throw new TranscriptQueryError("Unknown item in the selected Workbench thread.");
    return row;
  }

  private items(query: TranscriptQuery, cursor: Cursor, coverage: TranscriptQueryPage["coverage"]): TranscriptQueryPage {
    const bindings: Bindings = { ceiling: cursor.ceiling };
    let where = `${this.filters(query, bindings, true)} AND i.id <= @ceiling`;
    const descending = query.direction === "older";
    const direction = descending ? "DESC" : "ASC";
    if (query.around) {
      const anchor = this.locate(query, query.around);
      const neighbours = this.database.prepare(`WITH ordered AS (
        SELECT i.id, ROW_NUMBER() OVER (ORDER BY tr.turn_index, i.item_position, i.id) AS n
        FROM thread_items i JOIN thread_turns tr ON tr.id = i.turn_id WHERE i.thread_id = ? AND i.id <= ?)
        SELECT id FROM ordered WHERE abs(n - (SELECT n FROM ordered WHERE id = ?)) <= ?`)
        .all(anchor.threadId, cursor.ceiling, anchor.id, query.context) as { id: number }[];
      where += ` AND i.id IN (${neighbours.map(row => row.id).join(",") || "NULL"})`;
    }
    const time = query.threads.length === 1 ? "0" : "tr.created_at";
    if (cursor.position) {
      cursor.position.forEach((value, index) => {
        if (typeof value !== "string" && typeof value !== "number") throw new TranscriptQueryError("Invalid transcript cursor position.");
        bindings[`pos${index}`] = value;
      });
      where += ` AND (${time}, i.thread_id, tr.turn_index, i.item_position, i.id) ${descending ? "<" : ">"} (@pos0, @pos1, @pos2, @pos3, @pos4)`;
    }
    const candidates = this.database.prepare(`${this.selectItems(query, where)}
      ORDER BY ordTime ${direction}, threadId ${direction}, turnIndex ${direction}, position ${direction}, i.id ${direction}
      LIMIT ${BATCH_SIZE + 1}`).all(bindings) as ItemRow[];
    const batch = candidates.slice(0, BATCH_SIZE);
    const selected: ItemRow[] = [];
    let last: ItemRow | undefined;
    for (const row of batch) {
      last = row;
      if (query.action === "search" && !this.matches(row.id, query)) continue;
      selected.push(row);
      if (selected.length === query.limit) break;
    }
    const projected = this.projected(selected, query);
    const rows = selected.map(row => {
      const item = projected.get(row.id)!;
      return entry({ ...row, kind: item.kind }, previewTranscriptFields(item.fields));
    });
    const consumed = last ? batch.findIndex(row => row.id === last.id) + 1 : 0;
    const more = consumed < candidates.length;
    if (query.action === "read" && descending) rows.reverse();
    return { rows, coverage, scanned: consumed, nextCursor: more && last ? encode({ ...cursor, position: itemPosition(last) }) : null };
  }

  private fieldsCte(id: number, opaque: boolean) {
    return `WITH candidate AS (SELECT ${id} AS id), fields AS (${transcriptQueryFieldsSql(opaque)})`;
  }

  private matches(id: number, query: TranscriptQuery) {
    const bindings: Bindings = {};
    const fold = query.caseSensitive ? "text" : "wb_transcript_fold(text)";
    const term = (value: string, key: string) => {
      bindings[key] = query.caseSensitive ? value : value.toLowerCase();
      return `EXISTS(SELECT 1 FROM fields WHERE instr(${fold}, @${key}) > 0)`;
    };
    const include = query.queries.map((value, index) => term(value, `q${index}`));
    const exclude = query.excludes.map((value, index) => `NOT ${term(value, `e${index}`)}`);
    return !!this.database.prepare(`${this.fieldsCte(id, query.opaque)} SELECT 1
      WHERE (${include.join(query.any ? " OR " : " AND ") || "1"}) ${exclude.length ? `AND ${exclude.join(" AND ")}` : ""}`).get(bindings);
  }

  private projected(rows: ItemRow[], query: TranscriptQuery) {
    const result = new Map<number, { kind: string; fields: TranscriptField[] }>();
    const repository = new WorkbenchTranscriptRepository(this.database);
    for (const threadId of new Set(rows.map(row => row.threadId))) {
      const projection = repository.readStoredItems(threadId, rows.filter(row => row.threadId === threadId).map(row => row.id));
      if ("issues" in projection) {
        throw new Error(`Stored transcript projection failed: ${projection.issues.map(issue => `${issue.code} in ${issue.table}`).join(", ").slice(0, 500)}`);
      }
      for (const { root, item } of projection.data) {
        result.set(root.id, { kind: item.type, fields: transcriptItemFields(item, query.opaque) });
      }
    }
    return result;
  }

  private show(query: TranscriptQuery, cursor: Cursor, coverage: TranscriptQueryPage["coverage"]): TranscriptQueryPage {
    const row = this.locate(query, query.item!);
    const item = this.projected([row], query).get(row.id)!;
    const revision = digest(JSON.stringify(item));
    if (cursor.revision && cursor.revision !== revision) throw new TranscriptQueryError("Item changed since this expansion cursor. Read the item again.");
    const expanded = expandTranscriptFields(item.fields, cursor.field ?? 0, cursor.fieldOffset);
    const nextCursor = expanded.next
      ? encode({ ...cursor, field: expanded.next.index, fieldOffset: expanded.next.offset, revision }) : null;
    return { rows: [entry({ ...row, kind: item.kind }, expanded.fields)], coverage, scanned: 1, nextCursor };
  }
}
