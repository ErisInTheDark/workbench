/*
 * Exports:
 * - NarrativeThreadMatch: a thread's best-ranked narrative document for one FTS expression.
 * - SEARCHABLE_THREADS: join + filter keeping only threads workspace search may show (not archived).
 * - historyClauseExpression/historyAnyOf: FTS5 expressions for one parsed search clause or a set of literal terms.
 * - historyItemExpression: restrict an expression to the columns item search reads.
 * - retainSearchNarrative: copy expiring user/agent message text of searchable threads into the durable retained narrative before transcript retention deletes it.
 * - purgeArchivedSearchNarrative: delete retained text of archived threads.
 * - default WorkbenchHistoryIndex: connection-scoped FTS5 table `history_index` over every item's searchable text and retained narrative,
 *   backfilled in small background chunks (never inline) and refreshed from trigger-marked changes before each read.
 */
import type Database from "better-sqlite3";
import type { SearchClause } from "../search/workbench-search-ranking.ts";
import { HISTORY_FIELD_TABLES, historyFieldsSql } from "./history-fields.ts";

export interface NarrativeThreadMatch {
  /** Best (most negative) bm25 rank among the thread's matching narrative. */
  rank: number;
  messageKey: number;
}

/** Archive placement lives on top-level state; threads without one fall back to their own flag. */
export const SEARCHABLE_THREADS = `
  LEFT JOIN workbench_top_level_thread_states AS top_state ON top_state.thread_id = threads.id
  WHERE COALESCE(top_state.archived, threads.archived) = 0`;

const MARK = "INSERT INTO history_index_dirty (message_key) VALUES ($1) ON CONFLICT DO NOTHING;";
const MARKING_TRIGGERS: Record<string, string> = Object.fromEntries([
  ...HISTORY_FIELD_TABLES.flatMap(table => [
    [`history_${table}_insert`, `AFTER INSERT ON main.${table} BEGIN #NEW.item_id# END`],
    [`history_${table}_update`, `AFTER UPDATE ON main.${table} BEGIN #OLD.item_id# #NEW.item_id# END`],
    [`history_${table}_delete`, `AFTER DELETE ON main.${table} BEGIN #OLD.item_id# END`],
  ]),
  ["history_retained_insert", "AFTER INSERT ON main.workbench_search_narratives BEGIN #-NEW.id# END"],
  ["history_retained_delete", "AFTER DELETE ON main.workbench_search_narratives BEGIN #-OLD.id# END"],
]);
/** Tool text makes items heavy; small spans keep each background step to a short writer pause. */
const BACKFILL_SPAN = 1_000;
const MAX_CONTAINING_TERMS = 24;

function quote(text: string) {
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function historyAnyOf(terms: readonly string[]) {
  return terms.map(quote).join(" OR ");
}

/** Item-search form of an expression: opaque fields only on request. Matches run against `history_index` on the owning connection. */
export function historyItemExpression(expression: string, opaque: boolean) {
  return opaque ? expression : `{narrative detail} : (${expression})`;
}

/**
 * FTS5 expression for one clause. Words also match as prefixes (whole words match both arms, so bm25 ranks
 * them above completions), and camel-cased words also match their parts as a phrase ("SearchDialog" finds
 * "search dialog"). Null when the clause has no letters or digits, or is a lone letter.
 */
export function historyClauseExpression(clause: SearchClause) {
  if (!/[\p{L}\p{N}]/u.test(clause.value) || (clause.kind === "word" && clause.value.length < 2)) return null;
  const quoted = quote(clause.value);
  if (clause.kind === "phrase") return quoted;
  if (clause.value.length < 3) return quoted;
  const parts = clause.tokens.length > 1 ? ` OR ${quote(clause.tokens.join(" "))}*` : "";
  return `${quoted} OR ${quoted}*${parts}`;
}

/** One item's searchable text, split into narrative, detail and opt-in opaque columns. */
function documentsSql(candidate: string) {
  return `WITH candidate AS (${candidate}), fields AS (${historyFieldsSql(true)})
    INSERT INTO history_index (rowid, narrative, detail, opaque)
    SELECT item_id, group_concat(CASE WHEN narrative = 1 THEN text END, char(10)),
      group_concat(CASE WHEN narrative = 0 AND opaque = 0 THEN text END, char(10)),
      group_concat(CASE WHEN opaque = 1 THEN text END, char(10))
    FROM fields GROUP BY item_id`;
}

/** One user message's text parts, joined; null when it has none. */
function userText(id: string) {
  return `SELECT group_concat(text, char(10)) FROM thread_user_message_parts WHERE item_id = ${id} AND part_type = 'text'`;
}

/** Must run inside the retention transaction, before the expiring turns' items are deleted. */
export function retainSearchNarrative(database: Database.Database, expiringTurnIds: string, parameters: readonly unknown[]) {
  database.prepare(`
    INSERT OR IGNORE INTO workbench_search_narratives (item_public_id, thread_id, role, text)
    SELECT expiring.public_id, expiring.thread_id, expiring.role, expiring.text FROM (
      SELECT items.public_id, items.thread_id, 'user' AS role, (${userText("items.id")}) AS text
      FROM thread_items AS items WHERE items.type = 'userMessage' AND items.turn_id IN (${expiringTurnIds})
      UNION ALL
      SELECT items.public_id, items.thread_id, 'assistant', assistant.text
      FROM thread_items AS items JOIN thread_item_assistant_messages AS assistant ON assistant.item_id = items.id
      WHERE items.turn_id IN (${expiringTurnIds})
    ) AS expiring
    JOIN workbench_threads AS threads ON threads.id = expiring.thread_id
    ${SEARCHABLE_THREADS} AND expiring.text IS NOT NULL AND expiring.text <> ''
  `).run(...parameters, ...parameters);
}

/** Retained text lives only while its thread is searchable: archiving ends it for good, restoring never revives it. */
export function purgeArchivedSearchNarrative(database: Database.Database) {
  return database.prepare(`
    DELETE FROM workbench_search_narratives
    WHERE thread_id IN (SELECT thread_id FROM workbench_top_level_thread_states WHERE archived = 1)
  `).run().changes;
}

/**
 * Lives and dies with its writer connection: the TEMP schema never reaches the database file, backups or migrations.
 * Triggers generated from the field registry only mark changed items, so bulk transcript writes stay cheap; reads
 * reindex each marked item once. Items older than the triggers arrive by backfill. Document keys are thread item
 * ids for live items and negated `workbench_search_narratives` ids for retained narrative.
 */
export default class WorkbenchHistoryIndex {
  private readonly backfill: Record<"live" | "retained", { cursor: number; end: number }>;
  private readonly statements;

  constructor(private readonly database: Database.Database) {
    // A newer index on the same connection replaces any earlier one and re-backfills it.
    database.exec(`
      DROP TABLE IF EXISTS temp.history_index_vocabulary;
      DROP TABLE IF EXISTS temp.history_index;
      DROP TABLE IF EXISTS temp.history_index_dirty;
      ${Object.keys(MARKING_TRIGGERS).map(name => `DROP TRIGGER IF EXISTS temp.${name};`).join("\n")}
      CREATE VIRTUAL TABLE temp.history_index USING fts5(
        narrative, detail, opaque, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE temp.history_index_vocabulary USING fts5vocab(temp, history_index, col);
      CREATE TEMP TABLE history_index_dirty (message_key INTEGER PRIMARY KEY);
      ${Object.entries(MARKING_TRIGGERS).map(([name, body]) => `CREATE TEMP TRIGGER ${name} ${body.replaceAll(
        // Not OR IGNORE: an outer upsert's DO UPDATE overrides a trigger's OR policy with ABORT, failing settlement.
        /#([^#]+)#/gu, MARK,
      )};`).join("\n")}
    `);
    const maximum = (table: string) => (database.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get() as { id: number }).id;
    this.backfill = {
      live: { cursor: 1, end: maximum("thread_items") },
      retained: { cursor: 1, end: maximum("workbench_search_narratives") },
    };
    this.statements = {
      clearRange: database.prepare("DELETE FROM history_index WHERE rowid BETWEEN ? AND ?"),
      fillLiveRange: database.prepare(documentsSql("SELECT id FROM thread_items WHERE id BETWEEN ? AND ?")),
      fillRetainedRange: database.prepare(`
        INSERT INTO history_index (rowid, narrative) SELECT -id, text FROM workbench_search_narratives WHERE id BETWEEN ? AND ?
      `),
      hasDirty: database.prepare("SELECT 1 FROM history_index_dirty LIMIT 1"),
      refreshDirty: [
        "DELETE FROM history_index WHERE rowid IN (SELECT message_key FROM history_index_dirty)",
        documentsSql("SELECT message_key AS id FROM history_index_dirty WHERE message_key > 0"),
        `INSERT INTO history_index (rowid, narrative)
          SELECT -id, text FROM workbench_search_narratives
          WHERE id IN (SELECT -message_key FROM history_index_dirty WHERE message_key < 0)`,
        "DELETE FROM history_index_dirty",
      ].map(statement => database.prepare(statement)),
      // bm25 is only callable directly over the FTS scan, so ranks materialise before joining threads.
      matchThreads: database.prepare(`
        WITH hits AS MATERIALIZED (
          SELECT rowid AS message_key, rank FROM history_index WHERE history_index MATCH ?
        ), owned AS (
          SELECT hits.message_key, hits.rank, COALESCE(items.thread_id, retained.thread_id) AS thread_id
          FROM hits
          LEFT JOIN thread_items AS items ON hits.message_key > 0 AND items.id = hits.message_key
          LEFT JOIN workbench_search_narratives AS retained ON hits.message_key < 0 AND retained.id = -hits.message_key
        )
        SELECT owned.thread_id AS threadId, MIN(owned.rank) AS rank, owned.message_key AS messageKey
        FROM owned JOIN workbench_threads AS threads ON threads.id = owned.thread_id
        ${SEARCHABLE_THREADS}
        GROUP BY owned.thread_id
      `),
      // Tool text makes the vocabulary huge; only spellings within correction distance can matter.
      vocabulary: database.prepare(`
        SELECT term, SUM(doc) AS frequency FROM history_index_vocabulary
        WHERE term >= @from AND term < @to AND length(term) BETWEEN @shortest AND @longest AND (@narrative = 0 OR col = 'narrative')
        GROUP BY term
      `),
      containing: database.prepare(`
        SELECT term FROM history_index_vocabulary WHERE instr(term, @fragment) > 0 AND (@narrative = 0 OR col = 'narrative')
        GROUP BY term ORDER BY SUM(doc) DESC LIMIT @limit
      `),
      liveMessage: database.prepare(`
        SELECT items.type AS type, COALESCE(assistant.text, (${userText("items.id")}), '') AS text
        FROM thread_items AS items
        LEFT JOIN thread_item_assistant_messages AS assistant ON assistant.item_id = items.id
        WHERE items.id = ?
      `),
      retainedMessage: database.prepare("SELECT role, text FROM workbench_search_narratives WHERE id = ?"),
    };
  }

  /** Index the next chunk of history older than the triggers; false once all of it is indexed. */
  backfillStep() {
    const { live, retained } = this.backfill;
    const source = live.cursor <= live.end ? live : retained.cursor <= retained.end ? retained : null;
    if (!source) return false;
    const from = source.cursor;
    const to = Math.min(source.end, from + BACKFILL_SPAN - 1);
    this.database.transaction(() => {
      if (source === live) {
        this.statements.clearRange.run(from, to);
        this.statements.fillLiveRange.run(from, to);
      } else {
        this.statements.clearRange.run(-to, -from);
        this.statements.fillRetainedRange.run(from, to);
      }
    })();
    source.cursor = to + 1;
    return live.cursor <= live.end || retained.cursor <= retained.end;
  }

  /** Best narrative document per searchable thread for an FTS5 expression. */
  matchThreads(expression: string) {
    this.refresh();
    const matches = new Map<string, NarrativeThreadMatch>();
    for (const row of this.statements.matchThreads.all(`narrative : (${expression})`) as Array<NarrativeThreadMatch & { threadId: string }>) {
      matches.set(row.threadId, { messageKey: row.messageKey, rank: row.rank });
    }
    return matches;
  }

  /** Indexed words sharing a first letter and within two letters of the token's length, the candidates for typo correction. */
  vocabularyNear(token: string, { narrative = false }: { narrative?: boolean } = {}) {
    this.refresh();
    const first = String.fromCodePoint(token.codePointAt(0)!);
    return this.statements.vocabulary.all({
      from: first, to: `${first}\u{10FFFF}`, shortest: token.length - 2, longest: token.length + 2, narrative: Number(narrative),
    }) as Array<{ frequency: number; term: string }>;
  }

  /** Indexed words containing a fragment, most widespread first; finds identifiers like "workbenchsearchdialog". */
  vocabularyContaining(fragment: string, { limit = MAX_CONTAINING_TERMS, narrative = false }: { limit?: number; narrative?: boolean } = {}) {
    this.refresh();
    return (this.statements.containing.all({ fragment, limit, narrative: Number(narrative) }) as Array<{ term: string }>).map(({ term }) => term);
  }

  readMessage(messageKey: number) {
    if (messageKey < 0) {
      const row = this.statements.retainedMessage.get(-messageKey) as { role: "assistant" | "user"; text: string } | undefined;
      return row ?? null;
    }
    const row = this.statements.liveMessage.get(messageKey) as { text: string; type: string } | undefined;
    return row ? { role: row.type === "userMessage" ? "user" as const : "assistant" as const, text: row.text } : null;
  }

  /** Share of pre-trigger history indexed so far, 0..1; searches report it rather than finishing backfill inline. */
  progress() {
    const { live, retained } = this.backfill;
    const total = live.end + retained.end;
    return total ? Math.min(1, (live.cursor - 1 + retained.cursor - 1) / total) : 1;
  }

  /** Reindex marked documents so the next match sees every committed write. Backfill stays in the background. */
  refresh() {
    if (!this.statements.hasDirty.get()) return;
    this.database.transaction(() => {
      for (const statement of this.statements.refreshDirty) statement.run();
    })();
  }
}
