/*
 * Exports:
 * - default WorkbenchTranscriptIdentityRepository: own structural item identity independently of body recording.
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";
import {
  WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchItemId, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";

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

  merge(input: { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId; fromItemId: WorkbenchItemId; toItemId: WorkbenchItemId }) {
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
    const turns = new Set([input.turnId, ...evidence.sources.map(({ turnId }) => turnId)]);
    this.prepare(`
      DELETE FROM workbench_transcript_item_source_aliases AS source
      WHERE source.item_identity_id = @sourceId AND EXISTS (
        SELECT 1 FROM workbench_transcript_item_source_aliases AS target
        WHERE target.item_identity_id = @targetId
          AND target.turn_id = source.turn_id
          AND target.source_kind = source.source_kind
          AND target.reference = source.reference
          AND target.component_kind = source.component_kind
          AND target.component_index = source.component_index
      )
    `).run({ sourceId: source.id, targetId: target.id });
    this.prepare(`
      UPDATE workbench_transcript_item_source_aliases
      SET item_identity_id = ?
      WHERE item_identity_id = ?
    `).run(target.id, source.id);
    if (this.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workbench_thread_questionnaires'").get()) {
      this.prepare("UPDATE workbench_thread_questionnaires SET item_id = ? WHERE item_id = ?")
        .run(target.id, source.id);
      this.prepare("UPDATE workbench_thread_questionnaires SET insert_after_item_id = ? WHERE insert_after_item_id = ?")
        .run(target.id, source.id);
    }
    this.prepare("DELETE FROM workbench_transcript_item_identities WHERE id = ?").run(source.id);
    return this.read(target);
  }

  resolve(input: WorkbenchTranscriptItemIdentityLookup): WorkbenchTranscriptItemIdentity | null {
    const direct = this.row(input.itemId);
    if (direct) return direct.thread_id === input.threadId ? this.read(direct) : null;
    const candidates = this.prepare(`
      SELECT item_identity_id FROM workbench_transcript_item_source_aliases
      WHERE thread_id = @threadId AND reference = @itemId
        AND component_kind = 'item' AND component_index = 0
        AND (@turnId IS NULL OR turn_id = @turnId)
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
    const itemId = this.reconcileBodylessAlias(input, candidates)
      ?? this.selectOwner(input.threadId, candidates) ?? randomUUID();
    this.prepare(`
      INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(itemId, input.threadId);
    for (const source of input.sources) {
      this.prepare(`
        INSERT INTO workbench_transcript_item_source_aliases
          (turn_id, source_kind, reference, component_kind, component_index, thread_id, item_identity_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, source_kind, reference, component_kind, component_index) DO NOTHING
      `).run(
        source.turnId,
        source.kind,
        source.reference,
        source.component?.kind ?? "item",
        source.component?.index ?? 0,
        input.threadId,
        itemId,
      );
    }
    return this.read(this.row(itemId)!);
  }

  private reconcileBodylessAlias(input: WorkbenchTranscriptItemIdentityAdmission, candidates: readonly string[]) {
    const owners = [...new Set(candidates)];
    if (owners.length !== 2) return null;
    const bodies = this.prepare(`
      SELECT i.public_id, i.turn_id, i.type, u.client_id
      FROM thread_items i LEFT JOIN thread_item_user_messages u ON u.item_id = i.id
      WHERE i.public_id IN (?, ?)
    `).all(...owners) as Array<{ public_id: string; turn_id: string; type: string; client_id: string | null }>;
    const body = bodies[0];
    if (bodies.length !== 1 || !body) return null;
    const turnId = WorkbenchTurnIdSchema.parse(body.turn_id);
    if (input.sources.some((source) => source.turnId !== turnId)) return null;
    const identities = owners.map((id) => this.row(id)).map((row) => row ? this.read(row) : null);
    if (identities.some((identity) => !identity || identity.threadId !== input.threadId
      || identity.sources.some((source) => source.turnId !== turnId))) return null;
    const target = identities.find((identity) => identity?.itemId === body.public_id);
    const source = identities.find((identity) => identity?.itemId !== body.public_id);
    if (!source || !target) return null;
    const evidence = [...input.sources, ...source.sources, ...target.sources];
    if (evidence.some((entry) => entry.kind === "client"
      && (body.type !== "userMessage" || entry.reference !== body.client_id))) return null;
    const suppliedSource = (identity: WorkbenchTranscriptItemIdentity) => identity.sources.some((known) => (
      input.sources.some((entry) => entry.kind === known.kind
        && entry.reference === known.reference
        && (entry.component?.kind ?? "item") === (known.component?.kind ?? "item")
        && (entry.component?.index ?? 0) === (known.component?.index ?? 0))
    ));
    const clientMatch = body.client_id !== null
      && input.sources.some((entry) => entry.kind === "client" && entry.reference === body.client_id)
      && suppliedSource(source) && suppliedSource(target);
    if (!clientMatch && (!suppliedSource(source) || !suppliedSource(target))) return null;
    // The recorded body stays untouched. Only its proven bodyless alias moves.
    this.merge({ threadId: input.threadId, turnId, fromItemId: source.itemId, toItemId: target.itemId });
    return target.itemId;
  }

  private sourceOwners(threadId: WorkbenchThreadId, source: WorkbenchTranscriptItemSource) {
    const rows = this.prepare(`
      SELECT DISTINCT a.item_identity_id FROM workbench_transcript_item_source_aliases a
      JOIN thread_turns recorded ON recorded.id = a.turn_id
      JOIN thread_turns incoming ON incoming.id = @turnId AND incoming.thread_id = @threadId
      WHERE a.thread_id = @threadId AND a.source_kind = @kind AND a.reference = @reference
        AND a.component_kind = @componentKind AND a.component_index = @componentIndex
        AND (
          a.turn_id = @turnId
          OR (@kind <> 'provisional'
            AND recorded.harness_id = incoming.harness_id
            AND recorded.native_location = incoming.native_location
            AND recorded.native_thread_id = incoming.native_thread_id)
        )
    `).all({
      threadId,
      turnId: source.turnId,
      kind: source.kind,
      reference: source.reference,
      componentKind: source.component?.kind ?? "item",
      componentIndex: source.component?.index ?? 0,
    }) as Array<{ item_identity_id: string }>;
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
    const sources = this.prepare(`
      SELECT turn_id AS turnId, source_kind AS kind, reference,
        component_kind AS componentKind, component_index AS componentIndex
      FROM workbench_transcript_item_source_aliases WHERE item_identity_id = ?
      ORDER BY turn_id, source_kind, reference, component_kind, component_index
    `).all(row.id) as Array<{
      turnId: string;
      kind: WorkbenchTranscriptItemSource["kind"];
      reference: string;
      componentKind: WorkbenchTranscriptItemSource["component"]["kind"];
      componentIndex: number;
    }>;
    return {
      itemId: WorkbenchItemIdSchema.parse(row.id),
      threadId: WorkbenchThreadIdSchema.parse(row.thread_id),
      sources: sources.map(({ turnId, kind, reference, componentKind, componentIndex }) => ({
        turnId: WorkbenchTurnIdSchema.parse(turnId),
        kind,
        reference,
        component: { kind: componentKind, index: componentIndex },
      })),
    };
  }
}
