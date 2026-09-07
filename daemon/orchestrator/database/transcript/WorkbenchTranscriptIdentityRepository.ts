/*
 * Keywords: transcript, identity, admission, aliases, SQLite.
 * Exports:
 * - default WorkbenchTranscriptIdentityRepository: own structural item identity independently of body recording.
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import type {
  WorkbenchTranscriptItemIdentity,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
  WorkbenchTranscriptItemSource,
} from "./workbench-transcript-types.ts";

interface IdentityRow {
  id: string;
  thread_id: string;
}

export default class WorkbenchTranscriptIdentityRepository {
  constructor(private readonly database: Database.Database) {}

  admit(input: WorkbenchTranscriptItemIdentityAdmission): WorkbenchTranscriptItemIdentity {
    return this.database.transaction(() => this.admitInTransaction(input))();
  }

  admitMany(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]) {
    return this.database.transaction(() => inputs.map((input) => this.admitInTransaction(input)))();
  }

  merge(input: { threadId: string; turnId: string; fromItemId: string; toItemId: string }) {
    if (!this.database.inTransaction) throw new Error("Item identity reconciliation requires the body settlement transaction.");
    this.assertTurnOwner(input.threadId, input.turnId);
    const source = this.row(input.fromItemId);
    const target = this.row(input.toItemId);
    if (!source || !target || source.thread_id !== input.threadId || target.thread_id !== input.threadId) {
      throw new Error("Item identity reconciliation changed the owning thread.");
    }
    if (source.id === target.id) return this.read(target);
    if (this.database.prepare("SELECT id FROM thread_items WHERE public_id = ?").get(source.id)) {
      throw new Error("Transfer the transcript body before reconciling its item identity.");
    }
    const evidence = this.read(source);
    const turns = new Set([input.turnId, ...evidence.sources.map(({ turnId }) => turnId),
      ...evidence.legacyAliases.map(({ turnId }) => turnId)]);
    this.database.prepare(`
      UPDATE workbench_transcript_item_source_aliases SET item_identity_id = ? WHERE item_identity_id = ?
    `).run(target.id, source.id);
    this.database.prepare(`
      UPDATE workbench_transcript_item_legacy_aliases SET item_identity_id = ? WHERE item_identity_id = ?
    `).run(target.id, source.id);
    for (const turnId of turns) {
      const existing = this.database.prepare(`
        SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
        WHERE thread_id = ? AND turn_id = ? AND alias = ?
      `).get(input.threadId, turnId, source.id) as { item_identity_id: string } | undefined;
      if (existing && existing.item_identity_id !== target.id) {
        throw new Error("Item identity reconciliation has a conflicting legacy reference.");
      }
      this.database.prepare(`
        INSERT INTO workbench_transcript_item_legacy_aliases(thread_id, turn_id, alias, item_identity_id)
        VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, turn_id, alias) DO NOTHING
      `).run(input.threadId, turnId, source.id, target.id);
    }
    this.database.prepare("DELETE FROM workbench_transcript_item_identities WHERE id = ?").run(source.id);
    return this.read(target);
  }

  resolve(input: WorkbenchTranscriptItemIdentityLookup): WorkbenchTranscriptItemIdentity | null {
    const direct = this.row(input.itemId);
    if (direct) return direct.thread_id === input.threadId ? this.read(direct) : null;
    const candidates = this.database.prepare(`
      SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
      WHERE thread_id = @threadId AND alias = @itemId AND (@turnId IS NULL OR turn_id = @turnId)
      UNION
      SELECT item_identity_id FROM workbench_transcript_item_source_aliases
      WHERE thread_id = @threadId AND source_id = @itemId AND (@turnId IS NULL OR turn_id = @turnId)
    `).all({ ...input, turnId: input.turnId ?? null }) as Array<{ item_identity_id: string }>;
    const itemId = this.singleOwner(candidates.map((row) => row.item_identity_id));
    return itemId ? this.read(this.row(itemId)!) : null;
  }

  private admitInTransaction(input: WorkbenchTranscriptItemIdentityAdmission) {
    if (input.itemId !== undefined) z.uuid().parse(input.itemId);
    const candidates: string[] = [];
    const supplied = input.itemId ? this.row(input.itemId) : null;
    if (supplied && supplied.thread_id !== input.threadId) {
      throw new Error("Transcript item identity belongs to another thread.");
    }
    if (input.itemId) candidates.push(input.itemId);
    for (const source of input.sources) {
      this.assertTurnOwner(input.threadId, source.turnId);
      candidates.push(...this.sourceOwners(input.threadId, source));
    }
    for (const legacy of input.legacyAliases) {
      this.assertTurnOwner(input.threadId, legacy.turnId);
      const existing = this.database.prepare(`
        SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
        WHERE thread_id = ? AND turn_id = ? AND alias = ?
      `).get(input.threadId, legacy.turnId, legacy.alias) as { item_identity_id: string } | undefined;
      if (existing) candidates.push(existing.item_identity_id);
    }
    const itemId = this.singleOwner(candidates) ?? randomUUID();
    this.database.prepare(`
      INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(itemId, input.threadId);
    for (const source of input.sources) {
      this.database.prepare(`
        INSERT INTO workbench_transcript_item_source_aliases
          (turn_id, source_kind, source_id, thread_id, item_identity_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, source_kind, source_id) DO NOTHING
      `).run(source.turnId, source.kind, source.sourceId, input.threadId, itemId);
    }
    for (const legacy of input.legacyAliases) {
      this.database.prepare(`
        INSERT INTO workbench_transcript_item_legacy_aliases
          (thread_id, turn_id, alias, item_identity_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id, alias) DO NOTHING
      `).run(input.threadId, legacy.turnId, legacy.alias, itemId);
    }
    return this.read(this.row(itemId)!);
  }

  private sourceOwners(threadId: string, source: WorkbenchTranscriptItemSource) {
    const rows = this.database.prepare(`
      SELECT DISTINCT a.item_identity_id FROM workbench_transcript_item_source_aliases a
      JOIN thread_turns recorded ON recorded.id = a.turn_id
      JOIN thread_turns incoming ON incoming.id = @turnId AND incoming.thread_id = @threadId
      WHERE a.thread_id = @threadId AND a.source_kind = @kind AND a.source_id = @sourceId
        AND (
          a.turn_id = @turnId
          OR (@kind <> 'provisional'
            AND recorded.harness_id = incoming.harness_id
            AND recorded.native_location = incoming.native_location
            AND recorded.native_thread_id = incoming.native_thread_id)
        )
      UNION
      SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
      WHERE thread_id = @threadId AND turn_id = @turnId AND alias = @sourceId
    `).all({ threadId, ...source }) as Array<{ item_identity_id: string }>;
    return rows.map((row) => row.item_identity_id);
  }

  private assertTurnOwner(threadId: string, turnId: string) {
    if (!this.database.prepare("SELECT id FROM thread_turns WHERE id = ? AND thread_id = ?").get(turnId, threadId)) {
      throw new Error("Transcript item identity evidence has no turn in the owning thread.");
    }
  }

  private singleOwner(candidates: readonly string[]) {
    const owners = new Set(candidates);
    if (owners.size > 1) throw new Error("Transcript item identity is ambiguous; conflicting aliases require same-fact reconciliation.");
    return owners.values().next().value ?? null;
  }

  private row(itemId: string) {
    return this.database.prepare("SELECT id, thread_id FROM workbench_transcript_item_identities WHERE id = ?")
      .get(itemId) as IdentityRow | undefined;
  }

  private read(row: IdentityRow): WorkbenchTranscriptItemIdentity {
    return {
      itemId: row.id,
      threadId: row.thread_id,
      sources: this.database.prepare(`
        SELECT turn_id AS turnId, source_kind AS kind, source_id AS sourceId
        FROM workbench_transcript_item_source_aliases WHERE item_identity_id = ?
        ORDER BY turn_id, source_kind, source_id
      `).all(row.id) as WorkbenchTranscriptItemIdentity["sources"],
      legacyAliases: this.database.prepare(`
        SELECT turn_id AS turnId, alias FROM workbench_transcript_item_legacy_aliases
        WHERE item_identity_id = ? ORDER BY turn_id, alias
      `).all(row.id) as WorkbenchTranscriptItemIdentity["legacyAliases"],
    };
  }
}
