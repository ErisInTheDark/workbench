/*
 * Exports:
 * - default WorkbenchThreadStateRelationalRepository: own relational projection, parity status, and transactional reconciliation. Keywords: thread state, relational, sqlite, repository.
 * Local helpers project thread/draft/subagent facts, validate required augmentations, and reconcile changed rows. Keywords: thread state, parity, constraints.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import {
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import { normalizeThreadDisplayLayout } from "workbench-shared/workbench/thread/thread-display-layout";
import {
  asRecord,
  createSourceDigest,
  decodeGlobalDocument,
  parseProjectDocument,
  type SourceProject,
} from "./workbench-thread-state-document-source.ts";
import { projectThreadStateLayout } from "./workbench-thread-state-layout-projector.ts";
import { projectThreadStateQuestionnaires } from "./workbench-thread-state-questionnaire-projector.ts";
import {
  ANSWER_TABLE,
  ACTIVE_SUBAGENT_RELATIONSHIP_TABLE,
  ATTACHMENT_TABLE,
  DELETE_ORDER,
  DRAFT_TABLE,
  FOLDER_MEMBER_TABLE,
  GLOBAL_DOCUMENT_TABLE,
  GLOBAL_LAYOUT_TABLE,
  IDENTITY_TABLE,
  LAYOUT_DRAFT_TABLE,
  LAYOUT_FOLDER_TABLE,
  LAYOUT_ITEM_TABLE,
  LAYOUT_TABLE,
  LAYOUT_THREAD_TABLE,
  LIFECYCLE_TABLE,
  PINNED_IMPORT_TABLE,
  PENDING_SUBAGENT_RELATIONSHIP_TABLE,
  PROFILE_TABLE,
  PROJECT_DOCUMENT_TABLE,
  PROJECT_LAYOUT_TABLE,
  PROJECT_PROFILE_TABLE,
  PROJECTION_STATUS_TABLE,
  QUESTIONNAIRE_TABLE,
  RELATIONAL_TABLE_KEYS,
  RELATIONAL_TABLES,
  RETENTION_TABLE,
  SNOOZE_TABLE,
  SUBAGENT_TABLE,
  SUBAGENT_PARENT_TABLE,
  SUBAGENT_RELATIONSHIP_TABLE,
  THREAD_TABLE,
  addRow,
  canonicalRows,
  questionnaireId,
  rowKey,
  rowSignatures,
  subagentParentKey,
  subagentRelationshipKey,
  threadKey,
  type RelationalTableName,
  type RowSets,
  type SqlRow,
  type SqlValue,
} from "./workbench-thread-state-relational-tables.ts";
import type {
  WorkbenchSubagentParentSnapshot,
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./workbench-thread-state-shadow-types.ts";

function profileRow(profile: WorkbenchComposerProfileSelectionState) {
  return {
    selection_kind: profile.kind,
    profile_id: profile.kind === "profile" ? profile.profileId : null,
    agent_path: profile.settings.agentPath,
    agent_source: profile.settings.agentSource,
    harness_id: profile.settings.harness,
    model: profile.settings.model,
    reasoning_effort: profile.settings.reasoningEffort,
    service_tier: profile.settings.serviceTier,
  } satisfies SqlRow;
}

function lifecycleRow(lifecycle: WorkbenchThreadLifecycle) {
  const agent = "agent" in lifecycle ? lifecycle.agent : undefined;
  const providerTurnId = "turnId" in lifecycle ? lifecycle.turnId : agent?.turnId ?? null;
  return {
    lifecycle_kind: lifecycle.kind,
    reason: lifecycle.reason,
    settled: lifecycle.settled ? 1 : 0,
    provider_turn_id: providerTurnId ?? null,
    request_key: "requestKey" in lifecycle ? lifecycle.requestKey : null,
    agent_status: agent?.agentStatus ?? (lifecycle.kind === "working" ? "working" : null),
  } satisfies SqlRow;
}

function sourceRelationships(parents: readonly WorkbenchSubagentParentSnapshot[]) {
  return parents.flatMap(({ relationships }) => relationships);
}

function sourceDigestWithParents(sourceDigest: string, parents: readonly WorkbenchSubagentParentSnapshot[]) {
  return createHash("sha256").update(sourceDigest).update(JSON.stringify(
    parents.map(({ harness, nextDirectSubagentIndex, parentThreadId, projectId }) => (
      [projectId, harness, parentThreadId, nextDirectSubagentIndex]
    )),
  )).digest("hex");
}

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function sqliteConstraintFailureText(error: Error) {
  const structuralIdentity = /^(?:NOT NULL|UNIQUE) constraint failed: ((?:workbench_[a-z0-9_]+\.[a-z0-9_]+)(?:, workbench_[a-z0-9_]+\.[a-z0-9_]+)*)$/u
    .exec(error.message)?.[1];
  return structuralIdentity
    ? `Thread-state projection failed: SQLite constraint failure (${structuralIdentity}).`
    : "Thread-state projection failed: SQLite constraint failure.";
}

function readStatusRow(row: Record<string, SqlValue>): WorkbenchThreadStateShadowStatus {
  return {
    completedAt: row.completed_at as number | null,
    errorCode: row.error_code as WorkbenchThreadStateShadowStatus["errorCode"],
    errorText: row.error_text as string | null,
    generation: row.generation as number,
    mismatchCount: row.mismatch_count as number,
    projectedSubagentCount: row.projected_subagent_count as number,
    projectedThreadCount: row.projected_thread_count as number,
    sourceDigest: row.source_digest as string,
    sourceProjectCount: row.source_project_count as number,
    sourceProjectUpdatedAt: row.source_project_updated_at as number,
    sourceSubagentParentCount: row.source_subagent_parent_count as number,
    sourceSubagentCount: row.source_subagent_count as number,
    state: row.state as WorkbenchThreadStateShadowStatus["state"],
    updatedAt: row.updated_at as number,
  };
}

export default class WorkbenchThreadStateRelationalRepository {
  private readonly database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
  }

  readStatus(): WorkbenchThreadStateShadowStatus | null {
    const row = this.database.prepare(
      `SELECT * FROM ${PROJECTION_STATUS_TABLE} WHERE id = 1`,
    ).get() as Record<string, SqlValue> | undefined;
    return row ? readStatusRow(row) : null;
  }

  rebuild(request: WorkbenchThreadStateShadowRefresh): WorkbenchThreadStateShadowStatus {
    try {
      return this.rebuildProjection(request);
    } catch (error) {
      return this.recordFailure(error, request);
    }
  }

  private rebuildProjection(request: WorkbenchThreadStateShadowRefresh): WorkbenchThreadStateShadowStatus {
    const relationships = sourceRelationships(request.parents);
    const sourceRows = this.database.prepare(
      `SELECT project_id, document_json, updated_at FROM ${PROJECT_DOCUMENT_TABLE} ORDER BY project_id`,
    ).all() as Array<{ document_json: string; project_id: string; updated_at: number }>;
    const projects = sourceRows.map(({ document_json, project_id, updated_at }): SourceProject => ({
      document: parseProjectDocument(document_json, project_id),
      projectId: project_id,
      updatedAt: updated_at,
    }));
    const globalRows = this.database.prepare(
      `SELECT id, document_json FROM ${GLOBAL_DOCUMENT_TABLE} ORDER BY id`,
    ).all() as Array<{ document_json: string; id: string }>;
    const globals = new Map(globalRows.map(({ document_json, id }) => [
      id,
      decodeGlobalDocument(document_json, id),
    ]));
    const rows = this.projectRows(projects, request.parents, globals);
    const digest = sourceDigestWithParents(createSourceDigest(
      sourceRows.map(({ document_json, project_id, updated_at }) => ({
        documentJson: document_json,
        projectId: project_id,
        updatedAt: updated_at,
      })),
      globalRows.map(({ document_json, id }) => ({ documentJson: document_json, id })),
      relationships,
    ), request.parents);
    const previousGeneration = this.readStatus()?.generation ?? 0;

    return this.database.transaction(() => {
      const actualRows = new Map(RELATIONAL_TABLES.map((table) => [
        table,
        this.database.prepare(`SELECT * FROM ${table}`).all() as SqlRow[],
      ]));
      const expectedByTable = new Map(RELATIONAL_TABLES.map((table) => [
        table,
        new Map((rows.get(table) ?? []).map((row) => [rowKey(table, row), row])),
      ]));
      for (const table of DELETE_ORDER) {
        const expected = expectedByTable.get(table)!;
        for (const actual of actualRows.get(table) ?? []) {
          if (!expected.has(rowKey(table, actual))) this.delete(table, actual);
        }
      }
      for (const table of RELATIONAL_TABLES) {
        const actual = new Map((actualRows.get(table) ?? []).map((row) => [rowKey(table, row), row]));
        for (const [key, expected] of expectedByTable.get(table)!) {
          const existing = actual.get(key);
          if (!existing) this.insert(table, expected);
          else if (!isDeepStrictEqual(canonicalRows(existing), canonicalRows(expected))) this.update(table, expected);
        }
      }
      let mismatchCount = this.sourceCoverageMismatchCount(rows, projects, request.parents);
      for (const table of RELATIONAL_TABLES) {
        const expected = rowSignatures(rows.get(table) ?? []);
        const actual = rowSignatures(this.database.prepare(`SELECT * FROM ${table}`).all() as SqlRow[]);
        if (!isDeepStrictEqual(actual, expected)) mismatchCount += 1;
      }
      const statusRow = {
        id: 1,
        generation: previousGeneration + 1,
        state: mismatchCount ? "stale" : "complete",
        source_project_count: projects.length,
        source_project_updated_at: Math.max(0, ...projects.map(({ updatedAt }) => updatedAt)),
        source_subagent_parent_count: request.parents.length,
        source_subagent_count: relationships.length,
        source_digest: digest,
        projected_thread_count: rows.get(THREAD_TABLE)?.length ?? 0,
        projected_subagent_count: rows.get(SUBAGENT_TABLE)?.length ?? 0,
        mismatch_count: mismatchCount,
        completed_at: mismatchCount ? null : request.now,
        error_code: null,
        error_text: null,
        updated_at: request.now,
      } satisfies SqlRow;
      this.database.prepare(`DELETE FROM ${PROJECTION_STATUS_TABLE}`).run();
      this.insert(PROJECTION_STATUS_TABLE, statusRow);
      return readStatusRow(statusRow);
    })();
  }

  private recordFailure(error: unknown, request: WorkbenchThreadStateShadowRefresh): WorkbenchThreadStateShadowStatus {
    const relationships = sourceRelationships(request.parents);
    const previous = this.readStatus();
    const sourceRows = this.database.prepare(
      `SELECT project_id, document_json, updated_at FROM ${PROJECT_DOCUMENT_TABLE} ORDER BY project_id`,
    ).all() as Array<{ document_json: string; project_id: string; updated_at: number }>;
    const globalRows = this.database.prepare(
      `SELECT id, document_json FROM ${GLOBAL_DOCUMENT_TABLE} ORDER BY id`,
    ).all() as Array<{ document_json: string; id: string }>;
    const errorCode: WorkbenchThreadStateShadowStatus["errorCode"] = error instanceof SyntaxError
      ? "invalid-source"
      : isSqliteConstraintError(error)
        ? "constraint-failure"
        : "projection-failure";
    const errorText = errorCode === "invalid-source"
      ? "Thread-state projection failed: invalid source JSON."
      : errorCode === "constraint-failure"
        ? sqliteConstraintFailureText(error as Error)
        : "Thread-state projection failed: unexpected projector failure.";
    const row = {
      id: 1,
      generation: (previous?.generation ?? 0) + 1,
      state: "failed",
      source_project_count: sourceRows.length,
      source_project_updated_at: Math.max(0, ...sourceRows.map(({ updated_at }) => updated_at)),
      source_subagent_parent_count: request.parents.length,
      source_subagent_count: relationships.length,
      source_digest: sourceDigestWithParents(createSourceDigest(
        sourceRows.map(({ document_json, project_id, updated_at }) => ({
          documentJson: document_json,
          projectId: project_id,
          updatedAt: updated_at,
        })),
        globalRows.map(({ document_json, id }) => ({ documentJson: document_json, id })),
        relationships,
      ), request.parents),
      projected_thread_count: previous?.projectedThreadCount ?? 0,
      projected_subagent_count: previous?.projectedSubagentCount ?? 0,
      mismatch_count: previous?.mismatchCount ?? 0,
      completed_at: null,
      error_code: errorCode,
      error_text: errorText,
      updated_at: request.now,
    } satisfies SqlRow;
    this.database.transaction(() => {
      this.database.prepare(`DELETE FROM ${PROJECTION_STATUS_TABLE}`).run();
      this.insert(PROJECTION_STATUS_TABLE, row);
    })();
    return readStatusRow(row);
  }

  private projectRows(
    projects: readonly SourceProject[],
    parents: readonly WorkbenchSubagentParentSnapshot[],
    globals: ReadonlyMap<string, Record<string, unknown>>,
  ) {
    const relationships = sourceRelationships(parents);
    const rows: RowSets = new Map(RELATIONAL_TABLES.map((table) => [table, []]));
    const threads = new Map<string, SqlRow>();
    const identities = new Map<string, SqlRow>();
    const relationshipsByThread = new Map(relationships.map((relationship) => [
      threadKey(relationship.projectId, relationship.harness, relationship.threadId),
      relationship,
    ]));
    const ensureThread = (
      projectId: string,
      harness: "codex" | "copilot" | "opencode",
      providerThreadId: string,
      defaults: Partial<SqlRow> = {},
    ) => {
      const id = threadKey(projectId, harness, providerThreadId);
      const existing = threads.get(id);
      if (existing && defaults.thread_kind && defaults.thread_kind !== existing.thread_kind) {
        throw new Error("One provider thread identity appeared with multiple thread kinds.");
      }
      if (!existing) {
        threads.set(id, {
          id,
          project_id: projectId,
          thread_kind: defaults.thread_kind ?? "topLevel",
          visibility: defaults.visibility ?? "placeholder",
          title: defaults.title ?? providerThreadId,
          archived: defaults.archived ?? 0,
          pinned: defaults.pinned ?? 0,
          snoozed: defaults.snoozed ?? 0,
          provider_observed: defaults.provider_observed ?? 0,
          created_at: defaults.created_at ?? 0,
          updated_at: defaults.updated_at ?? 0,
          activity_at: defaults.activity_at ?? 0,
          order_at: defaults.order_at ?? null,
        });
        identities.set(id, { thread_id: id, project_id: projectId, harness_id: harness, provider_thread_id: providerThreadId });
      } else {
        threads.set(id, { ...existing, ...defaults, id, project_id: projectId });
      }
      return id;
    };

    for (const { document, projectId } of projects) {
      for (const record of document.records) {
        const relationship = relationshipsByThread.get(threadKey(projectId, record.identity.harness, record.identity.threadId));
        const metadata = record.entryKind === "thread"
          ? record.metadata
          : { archived: false as const, pinned: record.pinned, snoozed: false };
        const createdAt = record.entryKind === "subagent" ? record.createdAt : record.orderAt ?? record.activityAt;
        const updatedAt = record.entryKind === "subagent" ? record.updatedAt : record.activityAt;
        const id = ensureThread(projectId, record.identity.harness, record.identity.threadId, {
          thread_kind: record.entryKind === "subagent" ? "subagent" : "topLevel",
          visibility: "visible",
          title: record.title,
          archived: metadata.archived ? 1 : 0,
          pinned: metadata.pinned ? 1 : 0,
          snoozed: metadata.snoozed ? 1 : 0,
          provider_observed: record.providerObserved ? 1 : 0,
          created_at: createdAt,
          updated_at: updatedAt,
          activity_at: record.activityAt,
          order_at: record.entryKind === "thread" ? record.orderAt ?? null : null,
        });
        addRow(rows, LIFECYCLE_TABLE, { thread_id: id, ...lifecycleRow(record.lifecycle) });
        if (record.gitHistoryCleanedAt !== null || record.settledAt !== null || record.mcpGeneration !== null) {
          addRow(rows, RETENTION_TABLE, {
            thread_id: id,
            settled_at: record.settledAt,
            git_history_cleaned_at: record.gitHistoryCleanedAt,
            mcp_generation: record.mcpGeneration,
          });
        }
        if (record.profile) addRow(rows, PROFILE_TABLE, { thread_id: id, ...profileRow(record.profile) });
        if (record.entryKind === "subagent") {
          this.addSubagentRow(rows, relationship ?? {
            createdAt: record.createdAt,
            cwd: record.cwd,
            directSubagentIndex: record.directSubagentIndex,
            harness: record.identity.harness,
            name: record.name,
            parentThreadId: record.parentThreadId,
            profileId: record.profileId,
            profileName: record.profileName,
            projectId,
            threadId: record.identity.threadId,
            title: record.title,
            updatedAt: record.updatedAt,
          }, id, ensureThread);
        }
        projectThreadStateQuestionnaires(rows, id, record);
      }
      for (const draft of document.drafts) {
        addRow(rows, DRAFT_TABLE, {
          draft_id: draft.draftId,
          project_id: projectId,
          harness_id: draft.harness,
          prompt: draft.prompt,
          profile_id: draft.profileId,
          agent_path: draft.composerSettings.agentPath,
          agent_source: draft.composerSettings.agentSource,
          model: draft.composerSettings.model,
          reasoning_effort: draft.composerSettings.reasoningEffort,
          service_tier: draft.composerSettings.serviceTier,
          pinned: draft.pinned ? 1 : 0,
          snoozed: draft.snoozed ? 1 : 0,
          client_updated_at: draft.clientUpdatedAt,
          created_at: draft.createdAt,
          updated_at: draft.updatedAt,
        });
        draft.attachments.forEach((attachment, attachmentIndex) => addRow(rows, ATTACHMENT_TABLE, {
          draft_id: draft.draftId,
          attachment_index: attachmentIndex,
          opaque_json: JSON.stringify(attachment),
        }));
      }
      if (document.newThreadProfile) {
        addRow(rows, PROJECT_PROFILE_TABLE, { project_id: projectId, ...profileRow(document.newThreadProfile) });
      }
    }

    for (const parent of parents) {
      const parentThreadId = ensureThread(parent.projectId, parent.harness, parent.parentThreadId);
      const parentId = subagentParentKey(parent.projectId, parent.harness, parent.parentThreadId);
      addRow(rows, SUBAGENT_PARENT_TABLE, {
        id: parentId, project_id: parent.projectId, harness_id: parent.harness,
        parent_thread_id: parentThreadId, next_direct_subagent_index: parent.nextDirectSubagentIndex,
      });
      for (const relationship of parent.relationships) {
        const relationshipId = subagentRelationshipKey(parentId, relationship.directSubagentIndex);
        const pending = relationship.threadId.startsWith("pending:");
        addRow(rows, SUBAGENT_RELATIONSHIP_TABLE, {
          id: relationshipId, parent_id: parentId, relationship_kind: pending ? "pending" : "active",
          name_key: relationship.name.toLocaleLowerCase(), direct_subagent_index: relationship.directSubagentIndex,
          created_at: relationship.createdAt, updated_at: relationship.updatedAt,
        });
        if (pending) {
          addRow(rows, PENDING_SUBAGENT_RELATIONSHIP_TABLE, {
            relationship_id: relationshipId, relationship_kind: "pending",
            reservation_thread_id: relationship.threadId, cwd: relationship.cwd, name: relationship.name,
            profile_id: relationship.profileId, profile_name: relationship.profileName, title: relationship.title,
          });
          continue;
        }
        const id = ensureThread(relationship.projectId, relationship.harness, relationship.threadId, {
          thread_kind: "subagent", visibility: "visible", title: relationship.title,
          created_at: relationship.createdAt, updated_at: relationship.updatedAt,
          activity_at: relationship.updatedAt, order_at: null,
        });
        if (!(rows.get(SUBAGENT_TABLE) ?? []).some((row) => row.thread_id === id)) {
          this.addSubagentRow(rows, relationship, id, ensureThread);
        }
        addRow(rows, ACTIVE_SUBAGENT_RELATIONSHIP_TABLE, {
          relationship_id: relationshipId, relationship_kind: "active", thread_id: id,
        });
      }
    }

    for (const { document, projectId } of projects) {
      for (const record of document.records) {
        if (!record.snoozedUntil || record.entryKind !== "thread") continue;
        const target = record.snoozedUntil;
        addRow(rows, SNOOZE_TABLE, {
          source_thread_id: threadKey(projectId, record.identity.harness, record.identity.threadId),
          source_thread_kind: "topLevel",
          target_thread_id: ensureThread(target.projectId, target.identity.harness, target.identity.threadId),
          target_thread_kind: "topLevel",
        });
      }
      projectThreadStateLayout(rows, {
        displayOrder: document.displayOrder,
        ensureThread,
        layoutId: `project:${projectId}`,
        ownerKind: "project",
        projectId,
        revision: 0,
      });
    }
    const pinned = globals.get("pinnedLayout") ?? {};
    projectThreadStateLayout(rows, {
      displayOrder: normalizeThreadDisplayLayout(asRecord(pinned.displayOrder)),
      ensureThread,
      layoutId: "global:pinned",
      ownerKind: "pinned",
      revision: typeof pinned.revision === "number" && Number.isSafeInteger(pinned.revision) && pinned.revision >= 0 ? pinned.revision : 0,
    });
    const importedProjectIds = new Set(Array.isArray(pinned.importedProjectIds) ? pinned.importedProjectIds : []);
    for (const projectId of importedProjectIds) {
      if (typeof projectId === "string" && projectId) {
        addRow(rows, PINNED_IMPORT_TABLE, { project_id: projectId, layout_id: "global:pinned" });
      }
    }
    const home = globals.get("homeDisplayOrder") ?? {};
    projectThreadStateLayout(rows, {
      displayOrder: normalizeThreadDisplayLayout(asRecord(home.displayOrder)),
      ensureThread,
      layoutId: "global:home",
      ownerKind: "home",
      revision: typeof home.revision === "number" && Number.isSafeInteger(home.revision) && home.revision >= 0 ? home.revision : 0,
    });

    const projectedLifecycles = new Set((rows.get(LIFECYCLE_TABLE) ?? []).map((row) => row.thread_id));
    for (const threadId of threads.keys()) {
      if (projectedLifecycles.has(threadId)) continue;
      addRow(rows, LIFECYCLE_TABLE, {
        thread_id: threadId,
        lifecycle_kind: "needsAttention",
        reason: "noActiveTurn",
        settled: 0,
        provider_turn_id: null,
        request_key: null,
        agent_status: null,
      });
    }
    for (const row of threads.values()) addRow(rows, THREAD_TABLE, row);
    for (const row of identities.values()) addRow(rows, IDENTITY_TABLE, row);
    return rows;
  }

  private addSubagentRow(
    rows: RowSets,
    relationship: WorkbenchSubagentRelationship,
    id: string,
    ensureThread: (
      projectId: string,
      harness: "codex" | "copilot" | "opencode",
      providerThreadId: string,
      defaults?: Partial<SqlRow>,
    ) => string,
  ) {
    const parentId = ensureThread(relationship.projectId, relationship.harness, relationship.parentThreadId);
    addRow(rows, SUBAGENT_TABLE, {
      thread_id: id,
      thread_kind: "subagent",
      parent_thread_id: parentId,
      cwd: relationship.cwd,
      name: relationship.name,
      name_key: relationship.name.toLocaleLowerCase(),
      profile_id: relationship.profileId,
      profile_name: relationship.profileName,
      direct_subagent_index: relationship.directSubagentIndex,
    });
  }

  private sourceCoverageMismatchCount(
    rows: RowSets,
    projects: readonly SourceProject[],
    parents: readonly WorkbenchSubagentParentSnapshot[],
  ) {
    const relationships = sourceRelationships(parents);
    const identities = new Set((rows.get(IDENTITY_TABLE) ?? []).map((row) => row.thread_id as string));
    const lifecycles = new Set((rows.get(LIFECYCLE_TABLE) ?? []).map((row) => row.thread_id as string));
    const subagents = new Set((rows.get(SUBAGENT_TABLE) ?? []).map((row) => row.thread_id as string));
    const drafts = new Set((rows.get(DRAFT_TABLE) ?? []).map((row) => row.draft_id as string));
    const questionnaires = new Set((rows.get(QUESTIONNAIRE_TABLE) ?? []).map((row) => row.id as string));
    let mismatches = 0;
    for (const { document, projectId } of projects) {
      for (const record of document.records) {
        const id = threadKey(projectId, record.identity.harness, record.identity.threadId);
        if (!identities.has(id)) mismatches += 1;
        if (!lifecycles.has(id)) mismatches += 1;
        if (record.entryKind === "subagent" && !subagents.has(id)) mismatches += 1;
        const entries = [
          ...(record.pendingQuestionnaire ? [record.pendingQuestionnaire] : []),
          ...(record.questionnaireHistory ?? []),
        ];
        for (const entry of entries) {
          if (!questionnaires.has(questionnaireId(id, entry.itemId, entry.turnId, entry.requestKey))) mismatches += 1;
        }
      }
      for (const draft of document.drafts) {
        if (!drafts.has(draft.draftId)) mismatches += 1;
      }
    }
    for (const relationship of relationships) {
      if (!relationship.threadId.startsWith("pending:")
        && !subagents.has(threadKey(relationship.projectId, relationship.harness, relationship.threadId))) mismatches += 1;
    }
    return mismatches + this.relationalInvariantMismatchCount(rows);
  }

  private relationalInvariantMismatchCount(rows: RowSets) {
    const rowIds = (table: string, column: string) => new Set((rows.get(table) ?? []).map((row) => row[column]));
    const identities = rowIds(IDENTITY_TABLE, "thread_id");
    const lifecycles = rowIds(LIFECYCLE_TABLE, "thread_id");
    const subagents = rowIds(SUBAGENT_TABLE, "thread_id");
    const pendingRelationships = rowIds(PENDING_SUBAGENT_RELATIONSHIP_TABLE, "relationship_id");
    const activeRelationships = rowIds(ACTIVE_SUBAGENT_RELATIONSHIP_TABLE, "relationship_id");
    const projectLayouts = rowIds(PROJECT_LAYOUT_TABLE, "layout_id");
    const globalLayouts = rowIds(GLOBAL_LAYOUT_TABLE, "layout_id");
    const threadItems = rowIds(LAYOUT_THREAD_TABLE, "item_id");
    const draftItems = rowIds(LAYOUT_DRAFT_TABLE, "item_id");
    const folderItems = rowIds(LAYOUT_FOLDER_TABLE, "item_id");
    const answers = rowIds(ANSWER_TABLE, "questionnaire_id");
    let mismatches = 0;
    for (const thread of rows.get(THREAD_TABLE) ?? []) {
      if (!identities.has(thread.id)) mismatches += 1;
      if (!lifecycles.has(thread.id)) mismatches += 1;
      if ((thread.thread_kind === "subagent") !== subagents.has(thread.id)) mismatches += 1;
    }
    for (const relationship of rows.get(SUBAGENT_RELATIONSHIP_TABLE) ?? []) {
      const augmentationCount = Number(pendingRelationships.has(relationship.id))
        + Number(activeRelationships.has(relationship.id));
      if (augmentationCount !== 1) mismatches += 1;
      if ((relationship.relationship_kind === "pending") !== pendingRelationships.has(relationship.id)) mismatches += 1;
    }
    for (const layout of rows.get(LAYOUT_TABLE) ?? []) {
      const ownerCount = Number(projectLayouts.has(layout.id)) + Number(globalLayouts.has(layout.id));
      if (ownerCount !== 1) mismatches += 1;
    }
    for (const item of rows.get(LAYOUT_ITEM_TABLE) ?? []) {
      const augmentationCount = Number(threadItems.has(item.id))
        + Number(draftItems.has(item.id))
        + Number(folderItems.has(item.id));
      if (augmentationCount !== 1) mismatches += 1;
    }
    for (const questionnaire of rows.get(QUESTIONNAIRE_TABLE) ?? []) {
      if (questionnaire.state === "pending" && answers.has(questionnaire.id)) mismatches += 1;
    }
    return mismatches;
  }

  private insert(table: string, row: SqlRow) {
    const columns = Object.keys(row);
    this.database.prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...columns.map((column) => row[column]));
  }

  private delete(table: RelationalTableName, row: SqlRow) {
    const keys = RELATIONAL_TABLE_KEYS[table];
    this.database.prepare(
      `DELETE FROM ${table} WHERE ${keys.map((column) => `${column} = ?`).join(" AND ")}`,
    ).run(...keys.map((column) => row[column]));
  }

  private update(table: RelationalTableName, row: SqlRow) {
    const keys = RELATIONAL_TABLE_KEYS[table];
    const columns = Object.keys(row).filter((column) => !keys.includes(column));
    if (columns.length === 0) return;
    this.database.prepare(
      `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(", ")}`
      + ` WHERE ${keys.map((column) => `${column} = ?`).join(" AND ")}`,
    ).run(...columns.map((column) => row[column]), ...keys.map((column) => row[column]));
  }
}
