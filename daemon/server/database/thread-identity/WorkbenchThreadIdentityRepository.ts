/*
 * Exports:
 * - default WorkbenchThreadIdentityRepository: own UUID allocation and pending/turn identity on the database connection.
 */
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, ThreadReferenceSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type ProjectId, type ThreadReference, type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";

import { nativeLocationKey } from "./native-location-key.ts";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";
import { compileWorkbenchDatabaseStatement, updateRows } from "workbench-shared/database/workbench-database-statements";
import {
  coreTables,
  evidenceTables,
  interactionTables,
  itemTables,
  operationSourceTables,
  transcriptIdentityTables,
  usageTables,
  workbenchDatabaseTables,
  type CoreSchemaRows,
} from "../workbench-database-schema.ts";
import type {
  WorkbenchNativeThreadIdentity,
  WorkbenchThreadIdentityBinding,
  WorkbenchThreadIdentityLookup,
  WorkbenchThreadIdentityMetadata,
  WorkbenchThreadIdentityRecord,
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
  WorkbenchTurnIdentityRecord,
} from "./workbench-thread-identity-types.ts";

interface ThreadRow {
  id: string;
  project_id: string;
  project_root: string;
  identity_origin: "legacy" | "workbench";
}

type TurnRow = CoreSchemaRows["threadTurns"];

export default class WorkbenchThreadIdentityRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  observeMany(inputs: readonly WorkbenchThreadIdentityMetadata[]): WorkbenchThreadIdentityRecord[] {
    return this.database.transaction(() => inputs.map((input) => this.observe(input)))();
  }

  observe(input: WorkbenchThreadIdentityMetadata): WorkbenchThreadIdentityRecord {
    return this.database.transaction(() => {
      input = { ...input, projectId: new WorkbenchProjectRepository(this.database).admitStoredReference(input.projectId) };
      let existing = this.resolveNative(input.native);
      if (!existing) {
        const retainedId = this.threadRow(input.native.nativeThreadId)?.id
          ?? (this.database.prepare("SELECT thread_id FROM workbench_thread_legacy_aliases WHERE alias = ?")
            .get(input.native.nativeThreadId) as { thread_id: string } | undefined)?.thread_id;
        const retained = retainedId ? this.read(retainedId) : null;
        if (retained?.projectId === input.projectId && retained.bindings.length === 0) existing = this.canonical(retained.threadId);
      }
      if (existing && existing.projectId !== input.projectId) {
        throw new Error("Native thread metadata changed its Workbench project owner.");
      }
      const threadId = existing?.threadId ?? randomUUID();
      this.database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(input.native.harness);
      this.database.prepare(`
        INSERT INTO workbench_threads
          (id, identity_origin, project_id, project_root, title, transcript_content_version,
            created_at, updated_at, activity_at)
        VALUES (?, 'workbench', ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = CASE WHEN excluded.updated_at >= updated_at THEN excluded.title ELSE title END,
          updated_at = MAX(updated_at, excluded.updated_at),
          activity_at = MAX(activity_at, excluded.activity_at)
      `).run(threadId, input.projectId, input.projectRoot, input.title,
        input.createdAt, input.updatedAt, input.activityAt);
      const hasTurns = existing?.bindings.some((binding) => !binding.pending
        && binding.harness === input.native.harness
        && this.sameLocation(binding.nativeLocation, input.native.nativeLocation)
        && binding.nativeThreadId === input.native.nativeThreadId);
      if (!hasTurns) {
        this.database.prepare(`
          INSERT INTO workbench_pending_import_threads
            (thread_id, harness_id, native_location, native_thread_id, discovered_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
        `).run(threadId, input.native.harness, input.native.nativeLocation,
          input.native.nativeThreadId, input.createdAt, input.updatedAt);
      }
      return this.read(threadId)!;
    })();
  }

  resolve(input: WorkbenchThreadIdentityLookup): WorkbenchThreadIdentityRecord | null {
    return this.database.transaction(() => this.resolveInTransaction(input))();
  }

  private resolveInTransaction(input: WorkbenchThreadIdentityLookup): WorkbenchThreadIdentityRecord | null {
    if (input.projectId) input = { ...input, projectId: new WorkbenchProjectRepository(this.database).resolveStoredReference(input.projectId) };
    const direct = this.threadRow(input.threadId);
    if (direct?.identity_origin === "workbench") {
      if (input.projectId && direct.project_id !== input.projectId) {
        throw new Error("Workbench thread does not belong to the requested project.");
      }
      return this.canonical(direct.id);
    }
    const alias = this.database.prepare(`
      SELECT thread_id FROM workbench_thread_legacy_aliases WHERE alias = ?
    `).get(input.threadId) as { thread_id: string } | undefined;
    if (alias) {
      const resolved = this.read(alias.thread_id)!;
      if (input.projectId && resolved.projectId !== input.projectId) {
        throw new Error("Workbench thread does not belong to the requested project.");
      }
      return resolved;
    }
    const rows = this.database.prepare(`
      SELECT DISTINCT t.id
      FROM workbench_threads t JOIN (
        SELECT thread_id FROM thread_turns
        WHERE native_thread_id = ? AND (? IS NULL OR harness_id = ?)
        UNION ALL
        SELECT thread_id FROM workbench_pending_import_threads
        WHERE native_thread_id = ? AND (? IS NULL OR harness_id = ?)
      ) n ON n.thread_id = t.id
      WHERE (? IS NULL OR t.project_id = ?)
    `).all(input.threadId, input.harness ?? null, input.harness ?? null,
      input.threadId, input.harness ?? null, input.harness ?? null,
      input.projectId ?? null, input.projectId ?? null) as Array<{ id: string }>;
    if (rows.length > 1) throw new Error("Native thread identity is ambiguous within the requested scope.");
    if (rows[0]) return this.canonical(rows[0].id);
    if (direct) {
      if (input.projectId && direct.project_id !== input.projectId) {
        throw new Error("Workbench thread does not belong to the requested project.");
      }
      return this.canonical(direct.id);
    }
    return null;
  }

  resolveNative(native: WorkbenchNativeThreadIdentity): WorkbenchThreadIdentityRecord | null {
    return this.database.transaction(() => this.resolveNativeInTransaction(native))();
  }

  private resolveNativeInTransaction(native: WorkbenchNativeThreadIdentity): WorkbenchThreadIdentityRecord | null {
    const rows = this.database.prepare(`
      SELECT DISTINCT thread_id, native_location FROM (
        SELECT thread_id, native_location FROM thread_turns
        WHERE native_thread_id = ? AND harness_id = ?
        UNION ALL
        SELECT thread_id, native_location FROM workbench_pending_import_threads
        WHERE native_thread_id = ? AND harness_id = ?
      )
    `).all(native.nativeThreadId, native.harness,
      native.nativeThreadId, native.harness) as Array<{ thread_id: string; native_location: string }>;
    const owners = new Set(rows.filter((row) => this.sameLocation(row.native_location, native.nativeLocation)).map((row) => row.thread_id));
    if (owners.size > 1) throw new Error("Native thread identity has conflicting Workbench owners.");
    const owner = owners.values().next().value;
    return owner ? this.canonical(owner) : null;
  }

  list(): WorkbenchThreadIdentityRecord[] {
    return this.database.transaction(() => {
      this.repairPendingLocationAliases();
      const rows = this.database.prepare("SELECT id FROM workbench_threads WHERE identity_origin = 'workbench'")
        .all() as Array<{ id: string }>;
      return rows.map(({ id }) => this.read(id)!);
    })();
  }

  private repairPendingLocationAliases() {
    if (this.platform !== "win32") return;
    type BindingRow = Pick<TurnRow, "thread_id" | "harness_id" | "native_location" | "native_thread_id">;
    const key = (row: BindingRow) => JSON.stringify([
      row.harness_id, nativeLocationKey(row.native_location, this.platform), row.native_thread_id,
    ]);
    const imported = new Map<string, Set<string>>();
    const turns = this.database.prepare("SELECT DISTINCT thread_id, harness_id, native_location, native_thread_id FROM thread_turns").all() as BindingRow[];
    for (const turn of turns) {
      const owners = imported.get(key(turn)) ?? new Set<string>();
      owners.add(turn.thread_id);
      imported.set(key(turn), owners);
    }
    const pending = this.database.prepare("SELECT thread_id, harness_id, native_location, native_thread_id FROM workbench_pending_import_threads").all() as BindingRow[];
    for (const binding of pending) {
      const owners = imported.get(key(binding));
      if (!owners?.size) continue;
      if (owners.size !== 1) throw new Error("Native thread identity has conflicting imported Workbench owners.");
      const owner = this.resolveInTransaction({ threadId: ThreadReferenceSchema.parse(owners.values().next().value!) })!;
      if (owner.threadId === binding.thread_id) {
        this.database.prepare("DELETE FROM workbench_pending_import_threads WHERE thread_id = ?").run(binding.thread_id);
        continue;
      }
      const duplicate = this.database.prepare("SELECT * FROM workbench_threads WHERE id = ?")
        .get(binding.thread_id) as CoreSchemaRows["workbenchThreads"];
      if (duplicate.project_id !== owner.projectId || !this.sameLocation(duplicate.project_root, owner.projectRoot)) {
        throw new Error("Pending native alias changed its Workbench project owner.");
      }
      // Only the old metadata-only allocation bug is repairable here. Do not
      // merge transcript histories or cascade away independently admitted facts.
      const ownsFacts = duplicate.archived || duplicate.pinned || duplicate.snoozed || [
        coreTables.threadTurns, coreTables.workbenchThreadLifecycle,
        transcriptIdentityTables.itemIdentities, evidenceTables.transcriptAssetRefs,
        evidenceTables.transcriptCaptureGaps, evidenceTables.transcriptNativeRecords,
      ].some((table) => this.database.prepare(`SELECT 1 FROM ${table.name} WHERE thread_id = ? LIMIT 1`).get(binding.thread_id))
        || (this.hasThreadDomain() && [
          ["workbench_thread_states", "thread_id"],
          ["workbench_subagent_thread_states", "parent_thread_id"],
          ["workbench_thread_title_history", "thread_id"],
          ["workbench_subagent_parents", "parent_thread_id"],
          ["workbench_active_subagent_relationships", "thread_id"],
          ["workbench_sidebar_layout_threads", "thread_id"],
        ].some(([table, column]) => this.database.prepare(
          `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
        ).get(binding.thread_id)));
      if (ownsFacts) throw new Error("Duplicate pending thread owns durable facts and cannot be retired.");
      this.database.prepare(`
        UPDATE workbench_threads SET
          title = CASE WHEN ? >= updated_at THEN ? ELSE title END,
          created_at = MIN(created_at, ?), updated_at = MAX(updated_at, ?), activity_at = MAX(activity_at, ?)
        WHERE id = ?
      `).run(duplicate.updated_at, duplicate.title, duplicate.created_at,
        duplicate.updated_at, duplicate.activity_at, owner.threadId);
      this.database.prepare("UPDATE workbench_thread_legacy_aliases SET thread_id = ? WHERE thread_id = ?")
        .run(owner.threadId, binding.thread_id);
      this.preserveLegacyAlias(owner.threadId, binding.thread_id);
      this.database.prepare("DELETE FROM workbench_pending_import_threads WHERE thread_id = ?").run(binding.thread_id);
      this.database.prepare("DELETE FROM workbench_threads WHERE id = ?").run(binding.thread_id);
    }
  }

  preserveLegacyAlias(threadId: WorkbenchThreadId, alias: string) {
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO workbench_thread_legacy_aliases(alias, thread_id) VALUES (?, ?)")
        .run(alias, threadId);
      const row = this.database.prepare("SELECT thread_id FROM workbench_thread_legacy_aliases WHERE alias = ?")
        .get(alias) as { thread_id: string };
      if (row.thread_id !== threadId) throw new Error("Legacy thread reference already belongs to another Workbench thread.");
    })();
  }

  resolveTurn(input: WorkbenchTurnIdentityLookup): WorkbenchTurnIdentityRecord | null {
    return this.database.transaction(() => {
      const direct = this.turnRow(input.turnId);
      if (direct?.identity_origin === "workbench") {
        return direct.thread_id === input.threadId ? this.turnRecord(direct) : null;
      }
      const alias = this.database.prepare(`
        SELECT turn_id FROM workbench_turn_legacy_aliases WHERE thread_id = ? AND alias = ?
      `).get(input.threadId, input.turnId) as { turn_id: string } | undefined;
      if (alias) return this.turnRecord(this.turnRow(alias.turn_id)!);
      const rows = this.database.prepare(`
        SELECT * FROM thread_turns
        WHERE thread_id = ? AND (native_turn_id = ? OR (id = ? AND identity_origin = 'legacy'))
      `).all(input.threadId, input.turnId, input.turnId) as TurnRow[];
      if (rows.length > 1) throw new Error("Native turn identity is ambiguous within the requested thread.");
      return rows[0] ? this.canonicalTurn(rows[0]) : null;
    })();
  }

  observeTurns(inputs: readonly WorkbenchTurnIdentityMetadata[]): WorkbenchTurnIdentityRecord[] {
    if (inputs.length === 1 && inputs[0]!.turnIndex === undefined) return [this.observeTurn(inputs[0]!)];
    return this.database.transaction(() => {
      const known = inputs.map((input) => input.nativeTurnId === null ? this.turnRow(input.turnId) : this.nativeTurnRow(input));
      if (known.every(Boolean)) return inputs.map((input) => this.observeTurn(input));
      const existing = new Map<string, TurnRow>();
      for (const threadId of new Set(inputs.map((input) => input.threadId))) {
        const rows = this.database.prepare("SELECT * FROM thread_turns WHERE thread_id = ?").all(threadId) as TurnRow[];
        for (const row of rows) existing.set(row.id, row);
      }
      const successors = new Map<string, { input: WorkbenchTurnIdentityMetadata; row: TurnRow }>();
      const following = inputs.map((): { input: WorkbenchTurnIdentityMetadata; row: TurnRow } | undefined => undefined);
      for (let index = inputs.length - 1; index >= 0; index -= 1) {
        const input = inputs[index]!;
        const scope = JSON.stringify([input.threadId, input.harnessId, nativeLocationKey(input.nativeLocation, this.platform), input.nativeThreadId]);
        following[index] = successors.get(scope);
        if (known[index]) successors.set(scope, { input, row: known[index]! });
      }
      const previousKnown = new Map<string, TurnRow>();
      const admitted = inputs.map((input, index) => {
        const scope = JSON.stringify([input.threadId, input.harnessId, nativeLocationKey(input.nativeLocation, this.platform), input.nativeThreadId]);
        const previous = previousKnown.get(scope);
        if (known[index]) previousKnown.set(scope, known[index]!);
        const next = !known[index] ? following[index] : undefined;
        const successor = next
          ? next.input.nativeTurnId === null ? this.turnRow(next.row.id) : this.nativeTurnRow(next.input)
          : undefined;
        return this.observeTurn({
          ...input,
          ...(input.turnIndex === undefined && successor
            && (!previous || previous.turn_index < next!.row.turn_index)
            ? { turnIndex: successor.turn_index } : {}),
        });
      });
      const requested = new Set(admitted.map((record) => record.turnId));
      const shifted: WorkbenchTurnIdentityRecord[] = [];
      for (const previous of existing.values()) {
        const current = this.turnRow(previous.id);
        if (current && !requested.has(WorkbenchTurnIdSchema.parse(current.id)) && current.turn_index !== previous.turn_index) {
          shifted.push(this.canonicalTurn(current));
        }
      }
      // Requested records lead the batch. Additional changed indexes refresh the
      // committed lookup without rereading provider history or transcript bodies.
      return [...admitted.map((record) => this.turnRecord(this.turnRow(record.turnId)!)), ...shifted];
    })();
  }

  observeTurn(input: WorkbenchTurnIdentityMetadata): WorkbenchTurnIdentityRecord {
    return this.database.transaction(() => {
      const native = {
        harness: input.harnessId, nativeLocation: input.nativeLocation, nativeThreadId: input.nativeThreadId,
      };
      const owner = this.resolveNativeInTransaction(native);
      if (owner?.threadId !== input.threadId) throw new Error("Turn metadata changed its Workbench thread owner.");
      const existing = input.nativeTurnId === null
        ? this.turnRow(input.turnId)
        : this.nativeTurnRow(input);
      if (existing) {
        if (existing.thread_id !== input.threadId || existing.harness_id !== input.harnessId
          || !this.sameLocation(existing.native_location, input.nativeLocation) || existing.native_thread_id !== input.nativeThreadId) {
          throw new Error("Turn metadata changed its native or Workbench thread owner.");
        }
        return this.canonicalTurn(existing);
      }
      const thread = this.database.prepare("SELECT next_turn_index FROM workbench_threads WHERE id = ?")
        .get(input.threadId) as { next_turn_index: number };
      const turnId = randomUUID();
      const turnIndex = input.turnIndex ?? thread.next_turn_index;
      if (turnIndex < thread.next_turn_index) {
        const offset = thread.next_turn_index + 1;
        this.database.prepare("UPDATE thread_turns SET turn_index = turn_index + ? WHERE thread_id = ? AND turn_index >= ?")
          .run(offset, input.threadId, turnIndex);
        this.database.prepare("UPDATE thread_turns SET turn_index = turn_index - ? + 1 WHERE thread_id = ? AND turn_index >= ?")
          .run(offset, input.threadId, turnIndex + offset);
        this.database.prepare("UPDATE workbench_threads SET next_turn_index = next_turn_index + 1 WHERE id = ?")
          .run(input.threadId);
      }
      this.database.prepare(`
        INSERT INTO thread_turns
          (id, thread_id, identity_origin, turn_index, harness_id, native_location, native_thread_id,
            native_turn_id, state, created_at, started_at, ended_at, duration_ms)
        VALUES (?, ?, 'workbench', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(turnId, input.threadId, turnIndex, input.harnessId, input.nativeLocation, input.nativeThreadId,
        input.nativeTurnId, input.state, input.createdAt, input.startedAt, input.endedAt, input.durationMs);
      this.database.prepare("UPDATE workbench_threads SET next_turn_index = MAX(next_turn_index, ?) WHERE id = ?")
        .run(turnIndex + 1, input.threadId);
      this.admitTurn(input.threadId, native);
      return this.turnRecord(this.turnRow(turnId)!);
    })();
  }

  admitTurn(threadId: string, native: WorkbenchNativeThreadIdentity) {
    if (!this.database.inTransaction) throw new Error("Turn identity admission requires the catalog transaction.");
    const owner = this.threadRow(threadId);
    if (!owner) throw new Error("Turn identity admission has no Workbench thread.");
    if (owner.identity_origin !== "workbench") return;
    const resolved = this.resolveNativeInTransaction(native);
    if (resolved?.threadId !== threadId) throw new Error("Turn native identity belongs to another Workbench thread.");
    const pending = this.database.prepare(`
      SELECT native_location FROM workbench_pending_import_threads
      WHERE thread_id = ? AND harness_id = ? AND native_thread_id = ?
    `).get(threadId, native.harness, native.nativeThreadId) as { native_location: string } | undefined;
    if (pending && this.sameLocation(pending.native_location, native.nativeLocation)) {
      this.database.prepare("DELETE FROM workbench_pending_import_threads WHERE thread_id = ?").run(threadId);
    }
  }

  private sameLocation(left: string, right: string) {
    return nativeLocationKey(left, this.platform) === nativeLocationKey(right, this.platform);
  }

  private nativeTurnRow(input: WorkbenchTurnIdentityMetadata) {
    const rows = this.database.prepare(`
      SELECT * FROM thread_turns WHERE harness_id = ? AND native_thread_id = ? AND native_turn_id = ?
    `).all(input.harnessId, input.nativeThreadId, input.nativeTurnId) as TurnRow[];
    const matching = rows.filter((row) => this.sameLocation(row.native_location, input.nativeLocation));
    if (matching.length > 1) throw new Error("Native turn identity has conflicting Workbench owners.");
    return matching[0];
  }

  private canonical(threadId: string) {
    return this.threadRow(threadId)?.identity_origin === "legacy" ? this.relink(threadId) : this.read(threadId)!;
  }

  private canonicalTurn(row: TurnRow): WorkbenchTurnIdentityRecord {
    if (row.identity_origin === "workbench") return this.turnRecord(row);
    const turnId = randomUUID();
    this.database.pragma("defer_foreign_keys = ON");
    if (this.hasThreadDomain()) {
      this.database.prepare("UPDATE workbench_thread_questionnaires SET turn_id = ? WHERE turn_id = ?")
        .run(turnId, row.id);
    }
    const statements = [
      updateRows(coreTables.threadTurnMaterializations, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(coreTables.workbenchThreadLifecycle, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(itemTables.threadItems, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(evidenceTables.transcriptNativeRecords, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(evidenceTables.transcriptCaptureGaps, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(usageTables.threadUsageModelAttributions, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(usageTables.threadTurnUsage, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(transcriptIdentityTables.turnLegacyAliases, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(transcriptIdentityTables.itemSourceAliases, { turn_id: turnId }, { turn_id: row.id }),
      updateRows(coreTables.threadTurns, { id: turnId, identity_origin: "workbench" }, { id: row.id }),
    ];
    for (const statement of statements) {
      const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
      this.database.prepare(compiled.sql).run(...compiled.parameters);
    }
    this.database.prepare("INSERT INTO workbench_turn_legacy_aliases(thread_id, alias, turn_id) VALUES (?, ?, ?)")
      .run(row.thread_id, row.id, turnId);
    return this.turnRecord({ ...row, id: turnId, identity_origin: "workbench" });
  }

  private turnRow(turnId: string) {
    return this.database.prepare("SELECT * FROM thread_turns WHERE id = ?").get(turnId) as TurnRow | undefined;
  }

  private turnRecord(row: TurnRow): WorkbenchTurnIdentityRecord {
    return {
      threadId: WorkbenchThreadIdSchema.parse(row.thread_id), turnId: WorkbenchTurnIdSchema.parse(row.id), turnIndex: row.turn_index,
      native: {
        harness: row.harness_id, nativeLocation: row.native_location,
        nativeThreadId: NativeThreadIdSchema.parse(row.native_thread_id),
        nativeTurnId: row.native_turn_id === null ? null : NativeTurnIdSchema.parse(row.native_turn_id),
      },
    };
  }

  private relink(previousId: string) {
    const threadId = randomUUID();
    // Preserve the FK graph with UPDATE, never delete/reinsert a cascading parent.
    this.database.pragma("defer_foreign_keys = ON");
    if (this.hasThreadDomain()) {
      for (const [table, column] of [
        ["workbench_thread_states", "thread_id"],
        ["workbench_top_level_thread_states", "thread_id"],
        ["workbench_subagent_thread_states", "thread_id"],
        ["workbench_subagent_thread_states", "parent_thread_id"],
        ["workbench_thread_retention", "thread_id"],
        ["workbench_thread_snooze_dependencies", "source_thread_id"],
        ["workbench_thread_snooze_dependencies", "target_thread_id"],
        ["workbench_thread_profiles", "thread_id"],
        ["workbench_thread_questionnaires", "thread_id"],
        ["workbench_subagent_parents", "parent_thread_id"],
        ["workbench_subagent_relationships", "parent_thread_id"],
        ["workbench_active_subagent_relationships", "thread_id"],
        ["workbench_thread_git_observations", "thread_id"],
        ["workbench_sidebar_layout_threads", "thread_id"],
        ["workbench_thread_title_history", "thread_id"],
      ]) {
        this.database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(threadId, previousId);
      }
    }
    const statements = [
      updateRows(coreTables.threadTurns, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(coreTables.workbenchPendingImportThreads, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(coreTables.threadTurnMaterializations, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(coreTables.workbenchThreadLifecycle, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(itemTables.threadItems, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(interactionTables.threadItemInteractions, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(evidenceTables.transcriptNativeRecords, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(evidenceTables.transcriptAssetRefs, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(evidenceTables.transcriptCaptureGaps, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(transcriptIdentityTables.threadLegacyAliases, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(transcriptIdentityTables.turnLegacyAliases, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(transcriptIdentityTables.itemIdentities, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(transcriptIdentityTables.itemSourceAliases, { thread_id: threadId }, { thread_id: previousId }),
      updateRows(operationSourceTables.threadOperationCollaborationToolSources,
        { sender_thread_id: threadId }, { sender_thread_id: previousId }),
      updateRows(operationSourceTables.threadCollaborationReceivers,
        { receiver_thread_id: threadId }, { receiver_thread_id: previousId }),
      updateRows(operationSourceTables.threadCollaborationAgentStates,
        { agent_thread_id: threadId }, { agent_thread_id: previousId }),
      updateRows(coreTables.workbenchThreads, { id: threadId, identity_origin: "workbench" }, { id: previousId }),
    ];
    for (const statement of statements) {
      const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
      this.database.prepare(compiled.sql).run(...compiled.parameters);
    }
    this.database.prepare("INSERT INTO workbench_thread_legacy_aliases(alias, thread_id) VALUES (?, ?)")
      .run(previousId, threadId);
    return this.read(threadId)!;
  }

  private threadRow(threadId: string) {
    return this.database.prepare("SELECT id, project_id, project_root, identity_origin FROM workbench_threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;
  }

  admitRetainedReference(input: { reference: ThreadReference; projectId: ProjectId; projectRoot: string }): WorkbenchThreadIdentityRecord {
    return this.database.transaction(() => {
      input = { ...input, projectId: new WorkbenchProjectRepository(this.database).admitStoredReference(input.projectId) };
      const existing = this.resolve({ threadId: input.reference, projectId: input.projectId });
      if (existing) return existing;
      const threadId = randomUUID();
      // Retained relationship ownership is known; provider identity and metadata are not.
      this.database.prepare(`
        INSERT INTO workbench_threads(
          id, identity_origin, project_id, project_root, title, transcript_content_version,
          created_at, updated_at, activity_at
        ) VALUES (?, 'workbench', ?, ?, '', 0, 0, 0, 0)
      `).run(threadId, input.projectId, input.projectRoot);
      this.database.prepare("INSERT INTO workbench_thread_legacy_aliases(alias, thread_id) VALUES (?, ?)")
        .run(input.reference, threadId);
      return this.read(threadId)!;
    })();
  }

  private hasThreadDomain() {
    // The same identity owner admits legacy source metadata before the cutover DDL.
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workbench_thread_states'").get());
  }

  private read(threadId: string): WorkbenchThreadIdentityRecord | null {
    const row = this.threadRow(threadId);
    if (!row) return null;
    const bindings = this.database.prepare(`
      SELECT harness_id AS harness, native_location AS nativeLocation, native_thread_id AS nativeThreadId,
        0 AS pending, MAX(turn_index) AS turnIndex
      FROM thread_turns WHERE thread_id = ?
      GROUP BY harness_id, native_location, native_thread_id
      UNION ALL
      SELECT harness_id, native_location, native_thread_id, 1, NULL
      FROM workbench_pending_import_threads WHERE thread_id = ?
      ORDER BY pending DESC, turnIndex DESC
    `).all(threadId, threadId) as Array<{
      harness: string; nativeLocation: string; nativeThreadId: string; pending: number; turnIndex: number | null;
    }>;
    return {
      threadId: WorkbenchThreadIdSchema.parse(row.id),
      projectId: ProjectIdSchema.parse(row.project_id),
      projectRoot: row.project_root,
      bindings: bindings.map((binding) => ({
        ...binding, nativeThreadId: NativeThreadIdSchema.parse(binding.nativeThreadId), pending: Boolean(binding.pending),
      })),
    };
  }
}
