/*
 * Exports:
 * - NarrativeThreadMatch: a thread's best-ranked message for one FTS expression.
 * - SEARCHABLE_THREADS: join + filter keeping only threads search may show (not archived).
 * - retainSearchNarrative: copy expiring user/agent message text of searchable threads into the durable search narrative before transcript retention deletes it.
 * - purgeArchivedSearchNarrative: delete retained text of archived threads.
 * - default WorkbenchSearchNarrativeIndex: connection-scoped FTS5 index over live and retained message text, backfilled in bounded chunks and refreshed from trigger-marked changes before each read.
 */
import type Database from "better-sqlite3";

export interface NarrativeThreadMatch {
  /** Best (most negative) bm25 rank among the thread's matching messages. */
  rank: number;
  messageKey: number;
}

/** Archive placement lives on top-level state; threads without one fall back to their own flag. */
export const SEARCHABLE_THREADS = `
  LEFT JOIN workbench_top_level_thread_states AS top_state ON top_state.thread_id = threads.id
  WHERE COALESCE(top_state.archived, threads.archived) = 0`;

const MARKING_TRIGGERS = {
  search_narrative_user_insert: "AFTER INSERT ON main.thread_user_message_parts WHEN NEW.part_type = 'text' BEGIN #NEW.item_id# END",
  search_narrative_user_update: "AFTER UPDATE ON main.thread_user_message_parts BEGIN #OLD.item_id# #NEW.item_id# END",
  search_narrative_user_delete: "AFTER DELETE ON main.thread_user_message_parts WHEN OLD.part_type = 'text' BEGIN #OLD.item_id# END",
  search_narrative_assistant_insert: "AFTER INSERT ON main.thread_item_assistant_messages BEGIN #NEW.item_id# END",
  search_narrative_assistant_update: "AFTER UPDATE OF item_id, text ON main.thread_item_assistant_messages BEGIN #OLD.item_id# #NEW.item_id# END",
  search_narrative_assistant_delete: "AFTER DELETE ON main.thread_item_assistant_messages BEGIN #OLD.item_id# END",
  search_narrative_retained_insert: "AFTER INSERT ON main.workbench_search_narratives BEGIN #-NEW.id# END",
  search_narrative_retained_delete: "AFTER DELETE ON main.workbench_search_narratives BEGIN #-OLD.id# END",
};
const BACKFILL_SPAN = 4_000;
const MAX_CONTAINING_TERMS = 24;

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
 * Triggers only mark changed messages, so bulk transcript writes stay cheap; reads reindex each marked message once.
 * Messages older than the triggers arrive by backfill. Message keys are thread item ids for live messages and
 * negated `workbench_search_narratives` ids for retained ones.
 */
export default class WorkbenchSearchNarrativeIndex {
  private readonly backfill: Record<"live" | "retained", { cursor: number; end: number }>;
  private readonly statements;

  constructor(private readonly database: Database.Database) {
    // A newer index on the same connection replaces any earlier one and re-backfills it.
    database.exec(`
      DROP TABLE IF EXISTS temp.search_narrative_vocabulary;
      DROP TABLE IF EXISTS temp.search_narrative;
      DROP TABLE IF EXISTS temp.search_narrative_dirty;
      ${Object.keys(MARKING_TRIGGERS).map(name => `DROP TRIGGER IF EXISTS temp.${name};`).join("\n")}
      CREATE VIRTUAL TABLE temp.search_narrative USING fts5(
        body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE temp.search_narrative_vocabulary USING fts5vocab(temp, search_narrative, row);
      CREATE TEMP TABLE search_narrative_dirty (message_key INTEGER PRIMARY KEY);
      ${Object.entries(MARKING_TRIGGERS).map(([name, body]) => `CREATE TEMP TRIGGER ${name} ${body.replaceAll(
        // Not OR IGNORE: an outer upsert's DO UPDATE overrides a trigger's OR policy with ABORT, failing settlement.
        /#([^#]+)#/gu, "INSERT INTO search_narrative_dirty (message_key) VALUES ($1) ON CONFLICT DO NOTHING;",
      )};`).join("\n")}
    `);
    const maximum = (table: string) => (database.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get() as { id: number }).id;
    this.backfill = {
      live: { cursor: 1, end: maximum("thread_items") },
      retained: { cursor: 1, end: maximum("workbench_search_narratives") },
    };
    const dirtyLive = "SELECT message_key FROM search_narrative_dirty WHERE message_key > 0";
    this.statements = {
      clearRange: database.prepare("DELETE FROM search_narrative WHERE rowid BETWEEN ? AND ?"),
      fillUserRange: database.prepare(`
        INSERT INTO search_narrative (rowid, body)
        SELECT item_id, group_concat(text, char(10)) FROM thread_user_message_parts
        WHERE item_id BETWEEN ? AND ? AND part_type = 'text' GROUP BY item_id
      `),
      fillAssistantRange: database.prepare(`
        INSERT INTO search_narrative (rowid, body)
        SELECT item_id, text FROM thread_item_assistant_messages WHERE item_id BETWEEN ? AND ?
      `),
      fillRetainedRange: database.prepare(`
        INSERT INTO search_narrative (rowid, body) SELECT -id, text FROM workbench_search_narratives WHERE id BETWEEN ? AND ?
      `),
      hasDirty: database.prepare("SELECT 1 FROM search_narrative_dirty LIMIT 1"),
      refreshDirty: [
        "DELETE FROM search_narrative WHERE rowid IN (SELECT message_key FROM search_narrative_dirty)",
        `INSERT INTO search_narrative (rowid, body)
          SELECT item_id, group_concat(text, char(10)) FROM thread_user_message_parts
          WHERE item_id IN (${dirtyLive}) AND part_type = 'text' GROUP BY item_id`,
        `INSERT INTO search_narrative (rowid, body)
          SELECT item_id, text FROM thread_item_assistant_messages WHERE item_id IN (${dirtyLive})`,
        `INSERT INTO search_narrative (rowid, body)
          SELECT -id, text FROM workbench_search_narratives
          WHERE id IN (SELECT -message_key FROM search_narrative_dirty WHERE message_key < 0)`,
        "DELETE FROM search_narrative_dirty",
      ].map(statement => database.prepare(statement)),
      // bm25 is only callable directly over the FTS scan, so ranks materialise before joining threads.
      match: database.prepare(`
        WITH hits AS MATERIALIZED (
          SELECT rowid AS message_key, rank FROM search_narrative WHERE search_narrative MATCH ?
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
      vocabulary: database.prepare(`
        SELECT term, doc AS frequency FROM search_narrative_vocabulary WHERE term >= ? AND term < ?
      `),
      containing: database.prepare(`
        SELECT term FROM search_narrative_vocabulary WHERE instr(term, ?) > 0 ORDER BY doc DESC LIMIT ${MAX_CONTAINING_TERMS}
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

  /** Index the next chunk of narrative older than the triggers; false once all of it is indexed. */
  backfillStep() {
    const { live, retained } = this.backfill;
    const source = live.cursor <= live.end ? live : retained.cursor <= retained.end ? retained : null;
    if (!source) return false;
    const from = source.cursor;
    const to = Math.min(source.end, from + BACKFILL_SPAN - 1);
    this.database.transaction(() => {
      if (source === live) {
        this.statements.clearRange.run(from, to);
        this.statements.fillUserRange.run(from, to);
        this.statements.fillAssistantRange.run(from, to);
      } else {
        this.statements.clearRange.run(-to, -from);
        this.statements.fillRetainedRange.run(from, to);
      }
    })();
    source.cursor = to + 1;
    return live.cursor <= live.end || retained.cursor <= retained.end;
  }

  /** Best message per searchable thread for an FTS5 expression. */
  match(expression: string) {
    this.refresh();
    const matches = new Map<string, NarrativeThreadMatch>();
    for (const row of this.statements.match.all(expression) as Array<NarrativeThreadMatch & { threadId: string }>) {
      matches.set(row.threadId, { messageKey: row.messageKey, rank: row.rank });
    }
    return matches;
  }

  /** Indexed words sharing a first letter with the token, the candidates for typo correction. */
  vocabularyNear(token: string) {
    this.refresh();
    const first = String.fromCodePoint(token.codePointAt(0)!);
    return this.statements.vocabulary.all(first, `${first}\u{10FFFF}`) as Array<{ frequency: number; term: string }>;
  }

  /** Indexed words containing a fragment, most widespread first; finds identifiers like "workbenchsearchdialog". */
  vocabularyContaining(fragment: string) {
    this.refresh();
    return (this.statements.containing.all(fragment) as Array<{ term: string }>).map(({ term }) => term);
  }

  readMessage(messageKey: number) {
    if (messageKey < 0) {
      const row = this.statements.retainedMessage.get(-messageKey) as { role: "assistant" | "user"; text: string } | undefined;
      return row ?? null;
    }
    const row = this.statements.liveMessage.get(messageKey) as { text: string; type: string } | undefined;
    return row ? { role: row.type === "userMessage" ? "user" as const : "assistant" as const, text: row.text } : null;
  }

  private refresh() {
    while (this.backfillStep());
    if (!this.statements.hasDirty.get()) return;
    this.database.transaction(() => {
      for (const statement of this.statements.refreshDirty) statement.run();
    })();
  }
}
