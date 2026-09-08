/*
 * Keywords: transcript, identity, admission, client correlation, aliases, SQLite.
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
  private readonly statements = new Map<string, Database.Statement>();

  constructor(private readonly database: Database.Database) {}

  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  admit(input: WorkbenchTranscriptItemIdentityAdmission): WorkbenchTranscriptItemIdentity {
    return this.database.transaction(() => this.admitInTransaction(input))();
  }

  admitMany(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]) {
    return this.database.transaction(() => inputs.map((input) => this.admitInTransaction(input)))();
  }

  merge(input: { threadId: string; turnId: string; fromItemId: string; toItemId: string }) {
    if (!this.database.inTransaction) throw new Error("Item identity reconciliation requires a transaction.");
    this.assertTurnOwner(input.threadId, input.turnId);
    const source = this.row(input.fromItemId);
    const target = this.row(input.toItemId);
    if (!source || !target || source.thread_id !== input.threadId || target.thread_id !== input.threadId) {
      throw new Error("Item identity reconciliation changed the owning thread.");
    }
    if (source.id === target.id) return this.read(target);
    if (this.prepare("SELECT id FROM thread_items WHERE public_id = ?").get(source.id)) {
      throw new Error("Transfer the transcript body before reconciling its item identity.");
    }
    const evidence = this.read(source);
    const turns = new Set([input.turnId, ...evidence.sources.map(({ turnId }) => turnId),
      ...evidence.legacyAliases.map(({ turnId }) => turnId)]);
    this.prepare(`
      UPDATE workbench_transcript_item_source_aliases SET item_identity_id = ? WHERE item_identity_id = ?
    `).run(target.id, source.id);
    this.prepare(`
      UPDATE workbench_transcript_item_legacy_aliases SET item_identity_id = ? WHERE item_identity_id = ?
    `).run(target.id, source.id);
    for (const turnId of turns) {
      const existing = this.prepare(`
        SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
        WHERE thread_id = ? AND turn_id = ? AND alias = ?
      `).get(input.threadId, turnId, source.id) as { item_identity_id: string } | undefined;
      if (existing && existing.item_identity_id !== target.id) {
        throw new Error("Item identity reconciliation has a conflicting legacy reference.");
      }
      this.prepare(`
        INSERT INTO workbench_transcript_item_legacy_aliases(thread_id, turn_id, alias, item_identity_id)
        VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, turn_id, alias) DO NOTHING
      `).run(input.threadId, turnId, source.id, target.id);
    }
    this.prepare("DELETE FROM workbench_transcript_item_identities WHERE id = ?").run(source.id);
    return this.read(target);
  }

  resolve(input: WorkbenchTranscriptItemIdentityLookup): WorkbenchTranscriptItemIdentity | null {
    const direct = this.row(input.itemId);
    if (direct) return direct.thread_id === input.threadId ? this.read(direct) : null;
    const candidates = this.prepare(`
      SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
      WHERE thread_id = @threadId AND alias = @itemId AND (@turnId IS NULL OR turn_id = @turnId)
      UNION
      SELECT item_identity_id FROM workbench_transcript_item_source_aliases
      WHERE thread_id = @threadId AND source_id = @itemId AND (@turnId IS NULL OR turn_id = @turnId)
    `).all({ ...input, turnId: input.turnId ?? null }) as Array<{ item_identity_id: string }>;
    const itemId = this.selectOwner(input.threadId, candidates.map((row) => row.item_identity_id));
    return itemId ? this.read(this.row(itemId)!) : null;
  }

  private admitInTransaction(input: WorkbenchTranscriptItemIdentityAdmission) {
    if (input.itemId !== undefined) z.uuid().parse(input.itemId);
    const candidates: string[] = [];
    const supplied = input.itemId ? this.row(input.itemId) : null;
    if (supplied && supplied.thread_id !== input.threadId) {
      throw new Error("Transcript item identity belongs to another thread.");
    }
    if (input.itemId) candidates.push(supplied?.id
      ?? this.resolve({ threadId: input.threadId, itemId: input.itemId })?.itemId
      ?? input.itemId);
    for (const source of input.sources) {
      this.assertTurnOwner(input.threadId, source.turnId);
      candidates.push(...this.sourceOwners(input.threadId, source));
    }
    for (const legacy of input.legacyAliases) {
      this.assertTurnOwner(input.threadId, legacy.turnId);
      const existing = this.prepare(`
        SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
        WHERE thread_id = ? AND turn_id = ? AND alias = ?
      `).get(input.threadId, legacy.turnId, legacy.alias) as { item_identity_id: string } | undefined;
      if (existing) candidates.push(existing.item_identity_id);
    }
    const itemId = this.reconcileCorrelatedUserMessage(input, candidates)
      ?? this.selectOwner(input.threadId, candidates) ?? randomUUID();
    this.prepare(`
      INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(itemId, input.threadId);
    for (const source of input.sources) {
      this.prepare(`
        INSERT INTO workbench_transcript_item_source_aliases
          (turn_id, source_kind, source_id, thread_id, item_identity_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, source_kind, source_id) DO NOTHING
      `).run(source.turnId, source.kind, source.sourceId, input.threadId, itemId);
    }
    for (const legacy of input.legacyAliases) {
      this.prepare(`
        INSERT INTO workbench_transcript_item_legacy_aliases
          (thread_id, turn_id, alias, item_identity_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id, alias) DO NOTHING
      `).run(input.threadId, legacy.turnId, legacy.alias, itemId);
    }
    return this.read(this.row(itemId)!);
  }

  private reconcileCorrelatedUserMessage(input: WorkbenchTranscriptItemIdentityAdmission, candidates: readonly string[]) {
    const owners = [...new Set(candidates)];
    if (owners.length !== 2) return null;
    const clients = input.sources.filter((source) => source.kind === "client");
    const client = clients[0];
    if (clients.length !== 1 || !client || input.sources.some((source) => source.turnId !== client.turnId)) return null;
    const bodies = this.prepare(`
      SELECT i.public_id, i.turn_id, i.type, u.client_id
      FROM thread_items i LEFT JOIN thread_item_user_messages u ON u.item_id = i.id
      WHERE i.public_id IN (?, ?)
    `).all(...owners) as Array<{ public_id: string; turn_id: string; type: string; client_id: string | null }>;
    const body = bodies[0];
    if (bodies.length !== 1 || !body || body.type !== "userMessage"
      || body.turn_id !== client.turnId || body.client_id !== client.sourceId) return null;
    const identities = owners.map((id) => this.row(id)).map((row) => row ? this.read(row) : null);
    if (identities.some((identity) => !identity || identity.threadId !== input.threadId
      || identity.sources.some((source) => source.turnId !== client.turnId
        || (source.kind === "client" && source.sourceId !== client.sourceId))
      || identity.legacyAliases.some((alias) => alias.turnId !== client.turnId))) return null;
    const target = identities.find((identity) => identity?.itemId === body.public_id)!;
    const source = identities.find((identity) => identity?.itemId !== body.public_id)!;
    if (!target?.sources.some((entry) => entry.kind === "client" && entry.sourceId === client.sourceId)
      || !source || !input.sources.some((entry) => entry.kind === "stable"
        && source.sources.some((known) => known.kind === entry.kind && known.sourceId === entry.sourceId))) return null;
    const priorReference = this.prepare(`
      SELECT item_identity_id FROM workbench_transcript_item_legacy_aliases
      WHERE thread_id = ? AND turn_id = ? AND alias = ?
    `).get(input.threadId, client.turnId, source.itemId) as { item_identity_id: string } | undefined;
    if (priorReference && priorReference.item_identity_id !== target.itemId) return null;
    // The client-owned body stays untouched. Only its proven bodyless provider alias moves.
    this.merge({ threadId: input.threadId, turnId: client.turnId, fromItemId: source.itemId, toItemId: target.itemId });
    return target.itemId;
  }

  private sourceOwners(threadId: string, source: WorkbenchTranscriptItemSource) {
    const rows = this.prepare(`
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
    if (!this.prepare("SELECT id FROM thread_turns WHERE id = ? AND thread_id = ?").get(turnId, threadId)) {
      throw new Error("Transcript item identity evidence has no turn in the owning thread.");
    }
  }

  private selectOwner(threadId: string, candidates: readonly string[]) {
    const owners = new Set(candidates);
    const selectedItemId = owners.values().next().value ?? null;
    if (owners.size > 1) {
      console.warn("[workbench-transcript] conflicting aliases retained while selecting an existing identity", {
        threadId: threadId.slice(0, 100), selectedItemId, candidates: owners.size,
      });
    }
    return selectedItemId;
  }

  private row(itemId: string) {
    return this.prepare("SELECT id, thread_id FROM workbench_transcript_item_identities WHERE id = ?")
      .get(itemId) as IdentityRow | undefined;
  }

  private read(row: IdentityRow): WorkbenchTranscriptItemIdentity {
    return {
      itemId: row.id,
      threadId: row.thread_id,
      sources: this.prepare(`
        SELECT turn_id AS turnId, source_kind AS kind, source_id AS sourceId
        FROM workbench_transcript_item_source_aliases WHERE item_identity_id = ?
        ORDER BY turn_id, source_kind, source_id
      `).all(row.id) as WorkbenchTranscriptItemIdentity["sources"],
      legacyAliases: this.prepare(`
        SELECT turn_id AS turnId, alias FROM workbench_transcript_item_legacy_aliases
        WHERE item_identity_id = ? ORDER BY turn_id, alias
      `).all(row.id) as WorkbenchTranscriptItemIdentity["legacyAliases"],
    };
  }
}
