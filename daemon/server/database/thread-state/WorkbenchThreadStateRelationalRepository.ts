/*
 * Exports:
 * - default WorkbenchThreadStateRelationalRepository: own scoped relational reads and affected-fact writes.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type Database from "better-sqlite3";
import type { DraftId, ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import {
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchThreadDraftSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadLifecycleSchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchThreadStateGitRepository from "./WorkbenchThreadStateGitRepository.ts";
import WorkbenchThreadStateQuestionnaireRepository from "./WorkbenchThreadStateQuestionnaireRepository.ts";
import type {
  WorkbenchStoredThreadDraft, WorkbenchThreadRecordQuery, WorkbenchThreadStateCommit,
  WorkbenchThreadStateProjectDocument, WorkbenchThreadStateGlobalDocument,
} from "./workbench-thread-state-persistence.ts";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record.ts";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStoredThreadTitleHistory } from "../../WorkbenchThreadStateStore.ts";
import WorkbenchThreadStateLayoutRepository, { type WorkbenchThreadLayoutOwner } from "./WorkbenchThreadStateLayoutRepository.ts";

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

interface ThreadStateRow {
  thread_id: WorkbenchThreadId;
  thread_kind: "topLevel" | "subagent";
  harness_id: WorkbenchHarness;
  title: string;
  activity_at: number;
  provider_observed: 0 | 1;
  project_id: ProjectId;
  archived: 0 | 1 | null;
  pinned: 0 | 1 | null;
  snoozed: 0 | 1 | null;
  order_at: number | null;
  parent_thread_id: WorkbenchThreadId | null;
  cwd: string | null;
  name: string | null;
  profile_id: string | null;
  profile_name: string | null;
  direct_subagent_index: number | null;
  created_at: number | null;
  updated_at: number | null;
  child_pinned: 0 | 1 | null;
  lifecycle_kind: WorkbenchThreadLifecycle["kind"] | null;
  reason: WorkbenchThreadLifecycle["reason"] | null;
  settled: 0 | 1 | null;
  turn_id: WorkbenchTurnId | null;
  request_key: string | null;
  agent_status: "working" | "completed" | "blocked" | null;
  settled_at: number | null;
  git_history_cleaned_at: number | null;
  mcp_generation: string | null;
}

const SELECT_THREAD_STATES = `
  SELECT state.*, thread.project_id, top.archived, top.pinned, top.snoozed, top.order_at,
    child.parent_thread_id, child.cwd, child.name, child.profile_id, child.profile_name,
    child.direct_subagent_index, child.created_at, child.updated_at, child.pinned AS child_pinned,
    lifecycle.lifecycle_kind, lifecycle.reason, lifecycle.settled, lifecycle.turn_id,
    lifecycle.request_key, lifecycle.agent_status,
    retention.settled_at, retention.git_history_cleaned_at, retention.mcp_generation
  FROM workbench_thread_states state
  JOIN workbench_threads thread ON thread.id = state.thread_id
  LEFT JOIN workbench_thread_lifecycle lifecycle ON lifecycle.thread_id = state.thread_id
  LEFT JOIN workbench_top_level_thread_states top ON top.thread_id = state.thread_id
  LEFT JOIN workbench_subagent_thread_states child ON child.thread_id = state.thread_id
  LEFT JOIN workbench_thread_retention retention ON retention.thread_id = state.thread_id
`;

const UNFINISHED_CHILD = `EXISTS (
  SELECT 1 FROM workbench_subagent_thread_states child_state
  JOIN workbench_thread_lifecycle child_lifecycle ON child_lifecycle.thread_id = child_state.thread_id
  JOIN workbench_thread_states child_observation ON child_observation.thread_id = child_state.thread_id
  WHERE child_state.parent_thread_id = state.thread_id AND child_lifecycle.settled = 0 AND child_observation.provider_observed = 1
    AND child_lifecycle.lifecycle_kind IN ('working', 'needsAttention')
)`;

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
    context_window_tokens: profile.settings.contextWindowTokens ?? null,
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

export default class WorkbenchThreadStateRelationalRepository {
  private readonly database: Database.Database;
  private readonly git: WorkbenchThreadStateGitRepository;
  private readonly questionnaires: WorkbenchThreadStateQuestionnaireRepository;
  private readonly layouts: WorkbenchThreadStateLayoutRepository;

  constructor(
    database: Database.Database,
    private readonly threadIdentity = new WorkbenchThreadIdentityRepository(database),
  ) {
    this.database = database;
    this.git = new WorkbenchThreadStateGitRepository(database);
    this.questionnaires = new WorkbenchThreadStateQuestionnaireRepository(database);
    this.layouts = new WorkbenchThreadStateLayoutRepository(database, {
      resolveThread: (projectId, harness, threadId) => {
        const identity = this.threadIdentity.resolve({ projectId, harness, threadId });
        if (!identity) throw new Error("Layout references an unresolved canonical thread.");
        return identity.threadId;
      },
      readThread: (threadId) => {
        const identity = this.threadIdentity.resolve({ threadId });
        if (!identity) throw new Error("Layout references an unresolved canonical thread.");
        const state = this.database.prepare("SELECT harness_id FROM workbench_thread_states WHERE thread_id = ?")
          .get(threadId) as { harness_id: string } | undefined;
        return {
          threadId: identity.threadId, projectId: identity.projectId,
          harness: WorkbenchHarnessSchema.parse(state?.harness_id ?? identity.bindings[0]?.harness),
        };
      },
    });
  }

  readLayout(owner: WorkbenchThreadLayoutOwner) {
    return this.layouts.read(owner);
  }

  readProject(projectId: ProjectId): WorkbenchThreadStateProjectDocument {
    return this.database.transaction(() => ({
      version: 4 as const,
      records: this.readRecords({ selection: "project", projectId }),
      drafts: this.readDrafts(projectId).map(({ draft, pinned, snoozed }) => ({ ...draft, pinned, snoozed })),
      newThreadProfile: this.readProjectProfile(projectId),
      displayOrder: this.layouts.read({ kind: "project", projectId })?.displayOrder ?? {},
    }))();
  }

  readTitleHistories(projectId: ProjectId): WorkbenchStoredThreadTitleHistory[] {
    const rows = this.database.prepare(`
      SELECT title.thread_id, title.title, title.used_at, state.harness_id
      FROM workbench_thread_title_history title
      JOIN workbench_threads thread ON thread.id = title.thread_id
      LEFT JOIN workbench_thread_states state ON state.thread_id = title.thread_id
      WHERE thread.project_id = ? ORDER BY title.used_at DESC, title.title
    `).all(projectId) as Array<{ thread_id: WorkbenchThreadId; title: string; used_at: number; harness_id: string | null }>;
    const histories = new Map<string, WorkbenchStoredThreadTitleHistory>();
    for (const row of rows) {
      let history = histories.get(row.thread_id);
      if (!history) {
        const harness = WorkbenchHarnessSchema.parse(row.harness_id
          ?? this.threadIdentity.resolve({ projectId, threadId: row.thread_id })?.bindings[0]?.harness);
        history = { identity: { harness, threadId: row.thread_id }, titles: [] };
        histories.set(row.thread_id, history);
      }
      history.titles.push({ title: row.title, usedAt: row.used_at });
    }
    return [...histories.values()];
  }

  writeProject(projectId: ProjectId, document: WorkbenchThreadStateProjectDocument, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    this.database.transaction(() => {
      for (const record of document.records) {
        const identity = this.threadIdentity.resolve({ projectId, threadId: record.identity.threadId });
        if (!identity || identity.threadId !== record.identity.threadId) throw new Error("Project state requires a canonical thread in its project.");
      }
      if (document.drafts.some(draft => draft.projectId !== projectId)) throw new Error("Draft belongs to another project.");
      const retainedThreads = new Set(document.records.map(record => record.identity.threadId));
      const removedThreads = (this.database.prepare(`
        SELECT state.thread_id FROM workbench_thread_states state
        JOIN workbench_threads thread ON thread.id = state.thread_id WHERE thread.project_id = ?
      `).all(projectId) as Array<{ thread_id: WorkbenchThreadId }>)
        .filter(row => !retainedThreads.has(row.thread_id)).map(row => row.thread_id);
      const retainedDrafts = new Set(document.drafts.map(draft => draft.draftId));
      const removedDrafts = (this.database.prepare("SELECT draft_id FROM workbench_thread_drafts WHERE project_id = ?")
        .all(projectId) as Array<{ draft_id: DraftId }>)
        .filter(row => !retainedDrafts.has(row.draft_id));
      this.commit({
        records: document.records,
        drafts: document.drafts.map(({ pinned, snoozed, ...draft }) => ({ draft, pinned, snoozed })),
        projectProfiles: [{ projectId, profile: document.newThreadProfile }],
        layouts: [{ owner: { kind: "project", projectId }, revision: 0, displayOrder: document.displayOrder }],
        deletedThreadIds: removedThreads,
      });
      for (const { draft_id: draftId } of removedDrafts) {
        this.layouts.removeDraft(projectId, draftId);
        this.database.prepare("DELETE FROM workbench_thread_drafts WHERE project_id = ? AND draft_id = ?").run(projectId, draftId);
      }
      if (titleHistories !== undefined) {
        const desired = new Map<string, Map<string, number>>();
        for (const history of titleHistories) {
          const identity = this.threadIdentity.resolve({ projectId, ...history.identity });
          if (!identity || identity.threadId !== history.identity.threadId) throw new Error("Title history requires a canonical thread in its project.");
          const state = document.records.find(record => record.identity.threadId === identity.threadId);
          if (state && state.identity.harness !== history.identity.harness) throw new Error("Title history does not match its thread.");
          const titles = new Map(history.titles.map(entry => [entry.title, entry.usedAt]));
          if (desired.has(identity.threadId) || titles.size !== history.titles.length
            || history.titles.some(entry => !Number.isSafeInteger(entry.usedAt) || entry.usedAt < 0)) throw new Error("Title history contains invalid or duplicate facts.");
          desired.set(identity.threadId, titles);
        }
        const existing = this.database.prepare(`
          SELECT title.thread_id, title.title FROM workbench_thread_title_history title
          JOIN workbench_threads thread ON thread.id = title.thread_id WHERE thread.project_id = ?
        `).all(projectId) as Array<{ thread_id: string; title: string }>;
        for (const row of existing) {
          if (!desired.get(row.thread_id)?.has(row.title)) this.database.prepare("DELETE FROM workbench_thread_title_history WHERE thread_id = ? AND title = ?")
            .run(row.thread_id, row.title);
        }
        for (const [threadId, titles] of desired) for (const [title, usedAt] of titles) {
          this.writeDomainFact("workbench_thread_title_history", ["thread_id", "title"], { thread_id: threadId, title, used_at: usedAt });
        }
      }
    })();
  }

  readGlobal(id: WorkbenchThreadStateGlobalDocument["id"]): WorkbenchThreadStateGlobalDocument | null {
    return this.database.transaction(() => {
      const layout = this.layouts.read({ kind: id === "pinnedLayout" ? "pinned" : "home" });
      if (!layout) return null;
      return id === "pinnedLayout"
        ? { id, version: 1 as const, ...layout, importedProjectIds: this.readPinnedImports() }
        : { id, version: 1 as const, ...layout };
    })();
  }

  writeGlobal(document: WorkbenchThreadStateGlobalDocument) {
    this.commit({
      layouts: [{ owner: { kind: document.id === "pinnedLayout" ? "pinned" : "home" }, revision: document.revision, displayOrder: document.displayOrder }],
      ...(document.id === "pinnedLayout" ? { pinnedImports: document.importedProjectIds } : {}),
    });
  }

  commit(changes: WorkbenchThreadStateCommit) {
    this.database.transaction(() => {
      if (changes.projectId !== undefined) {
        const projectId = changes.projectId;
        for (const threadId of [
          ...(changes.records ?? []).map(record => record.identity.threadId),
          ...(changes.deletedThreadIds ?? []),
        ]) {
          const identity = this.threadIdentity.resolve({ projectId, threadId });
          if (!identity || identity.threadId !== threadId) throw new Error("Project state requires a canonical thread in its project.");
        }
        if (changes.drafts?.some(({ draft }) => draft.projectId !== projectId)
          || changes.projectProfiles?.some(profile => profile.projectId !== projectId)
          || changes.layouts?.some(({ owner }) => owner.kind !== "project" || owner.projectId !== projectId)
          || changes.pinnedImports !== undefined) throw new Error("Changed facts belong to another project.");
      }
      this.writeDrafts(changes.drafts ?? []);
      this.writeRecords(changes.records ?? []);
      for (const { projectId, profile } of changes.projectProfiles ?? []) {
        if (profile) {
          this.database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(profile.settings.harness);
          this.writeDomainFact("workbench_project_thread_profiles", ["project_id"], {
            project_id: projectId, ...profileRow(WorkbenchComposerProfileSelectionSchema.parse(profile)),
          });
        } else {
          this.database.prepare("DELETE FROM workbench_project_thread_profiles WHERE project_id = ?").run(projectId);
        }
      }
      for (const layout of changes.layouts ?? []) this.layouts.replace(layout.owner, layout.revision, layout.displayOrder);
      for (const draftId of changes.deletedDraftIds ?? []) {
        const draft = this.database.prepare("SELECT project_id FROM workbench_thread_drafts WHERE draft_id = ?")
          .get(draftId) as { project_id: ProjectId } | undefined;
        if (changes.projectId !== undefined && draft?.project_id !== changes.projectId) continue;
        if (draft) this.layouts.removeDraft(draft.project_id, draftId);
        this.database.prepare("DELETE FROM workbench_thread_drafts WHERE draft_id = ?").run(draftId);
      }
      for (const threadId of changes.deletedThreadIds ?? []) {
        this.database.prepare("DELETE FROM workbench_thread_states WHERE thread_id = ?").run(threadId);
      }
      if (changes.pinnedImports !== undefined) {
        this.database.prepare("DELETE FROM workbench_sidebar_pinned_imports").run();
        if (changes.pinnedImports.length) {
          const pinned = this.database.prepare(`
            SELECT layout_id FROM workbench_sidebar_global_layouts WHERE owner_kind = 'pinned'
          `).get() as { layout_id: string } | undefined;
          if (!pinned) throw new Error("Pinned imports require a pinned layout.");
          const insert = this.database.prepare(`
            INSERT INTO workbench_sidebar_pinned_imports(project_id, layout_id, owner_kind) VALUES (?, ?, 'pinned')
          `);
          for (const projectId of changes.pinnedImports) insert.run(projectId, pinned.layout_id);
        }
      }
    })();
  }

  readPinnedImports(): ProjectId[] {
    return (this.database.prepare("SELECT project_id FROM workbench_sidebar_pinned_imports ORDER BY project_id").all() as Array<{ project_id: ProjectId }>)
      .map((row) => row.project_id);
  }

  readProjectProfile(projectId: ProjectId): WorkbenchComposerProfileSelectionState | null {
    const profile = this.database.prepare("SELECT * FROM workbench_project_thread_profiles WHERE project_id = ?")
      .get(projectId) as Record<string, SqlValue> | undefined;
    return profile ? WorkbenchComposerProfileSelectionSchema.parse({
      kind: profile.selection_kind, ...(profile.selection_kind === "profile" ? { profileId: profile.profile_id } : {}),
      settings: {
        harness: profile.harness_id, agentPath: profile.agent_path, agentSource: profile.agent_source,
        model: profile.model, reasoningEffort: profile.reasoning_effort, serviceTier: profile.service_tier,
        ...(profile.context_window_tokens !== null ? { contextWindowTokens: profile.context_window_tokens as number } : {}),
      },
    }) : null;
  }

  readDrafts(projectId: ProjectId): WorkbenchStoredThreadDraft[] {
    const rows = this.database.prepare(`
      SELECT * FROM workbench_thread_drafts WHERE project_id = ? ORDER BY updated_at DESC, draft_id
    `).all(projectId) as Array<Record<string, SqlValue>>;
    return rows.map((row) => {
      const attachments = this.database.prepare(`
        SELECT attachment_index, attachment_id, url FROM workbench_thread_draft_attachments
        WHERE draft_id = ? ORDER BY attachment_index
      `).all(row.id) as Array<{ attachment_index: number; attachment_id: string; url: string }>;
      return {
        pinned: Boolean(row.pinned), snoozed: Boolean(row.snoozed),
        draft: WorkbenchThreadDraftSchema.parse({
          draftId: row.draft_id, projectId: row.project_id,
          prompt: row.prompt, profileId: row.profile_id,
          composerSettings: {
            harness: row.harness_id, agentPath: row.agent_path, agentSource: row.agent_source,
            model: row.model, reasoningEffort: row.reasoning_effort, serviceTier: row.service_tier,
            ...(row.context_window_tokens !== null ? { contextWindowTokens: row.context_window_tokens as number } : {}),
          },
          clientUpdatedAt: row.client_updated_at, createdAt: row.created_at, updatedAt: row.updated_at,
          attachments: attachments.map((attachment, index) => {
            if (attachment.attachment_index !== index) throw new Error("Draft has incomplete attachment ordering.");
            return { id: attachment.attachment_id, url: attachment.url };
          }),
        }),
      };
    });
  }

  writeDrafts(drafts: readonly WorkbenchStoredThreadDraft[]) {
    this.database.transaction(() => {
      for (const stored of drafts) {
        const draft = WorkbenchThreadDraftSchema.parse(stored.draft);
        this.database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES (?)").run(draft.composerSettings.harness);
        const previous = this.database.prepare("SELECT id FROM workbench_thread_drafts WHERE draft_id = ?")
          .get(draft.draftId) as { id: string } | undefined;
        const id = previous?.id ?? randomUUID();
        this.writeDomainFact("workbench_thread_drafts", ["id"], {
          id, draft_id: draft.draftId, project_id: draft.projectId, harness_id: draft.composerSettings.harness,
          prompt: draft.prompt, profile_id: draft.profileId, agent_path: draft.composerSettings.agentPath,
          agent_source: draft.composerSettings.agentSource, model: draft.composerSettings.model,
          reasoning_effort: draft.composerSettings.reasoningEffort, service_tier: draft.composerSettings.serviceTier,
          context_window_tokens: draft.composerSettings.contextWindowTokens ?? null,
          pinned: Number(stored.pinned), snoozed: Number(stored.snoozed), client_updated_at: draft.clientUpdatedAt,
          created_at: draft.createdAt, updated_at: draft.updatedAt,
        });
        const previousAttachments = this.database.prepare(`
          SELECT attachment_id, url FROM workbench_thread_draft_attachments WHERE draft_id = ? ORDER BY attachment_index
        `).all(id) as Array<{ attachment_id: string; url: string }>;
        if (isDeepStrictEqual(previousAttachments.map((attachment) => ({
          id: attachment.attachment_id, url: attachment.url,
        })), draft.attachments)) continue;
        this.database.prepare("DELETE FROM workbench_thread_draft_attachments WHERE draft_id = ?").run(id);
        const insert = this.database.prepare(`
          INSERT INTO workbench_thread_draft_attachments(draft_id, attachment_index, attachment_id, url) VALUES (?, ?, ?, ?)
        `);
        draft.attachments.forEach((attachment, index) => insert.run(id, index, attachment.id, attachment.url));
      }
    })();
  }

  readRecords(query: WorkbenchThreadRecordQuery): WorkbenchThreadStateRecord[] {
    const parameters: Array<string | number> = [];
    let where: string;
    switch (query.selection) {
      case "threads":
        if (!query.threadIds.length) return [];
        where = `state.thread_id IN (${query.threadIds.map(() => "?").join(",")})`;
        parameters.push(...query.threadIds);
        if (query.projectId !== undefined) {
          where += " AND thread.project_id = ?";
          parameters.push(query.projectId);
        }
        break;
      case "children":
        where = "child.parent_thread_id = ?";
        parameters.push(query.parentThreadId);
        break;
      case "parentStatus":
        if (!query.parentThreadIds.length) return [];
        where = `child.parent_thread_id IN (${query.parentThreadIds.map(() => "?").join(",")})
          AND state.provider_observed = 1 AND lifecycle.settled = 0 AND lifecycle.lifecycle_kind IN ('working', 'needsAttention')`;
        parameters.push(...query.parentThreadIds);
        break;
      case "live":
        where = `thread.project_id = ? AND (
          (top.archived = 0 AND (state.provider_observed = 1 OR lifecycle.settled = 1) AND (
            lifecycle.settled = 0
            OR (lifecycle.lifecycle_kind = 'completed' AND ${UNFINISHED_CHILD})
          ))
          OR (state.thread_kind = 'subagent' AND state.provider_observed = 1 AND lifecycle.settled = 0
            AND lifecycle.lifecycle_kind IN ('working', 'needsAttention') AND EXISTS (
            SELECT 1 FROM workbench_top_level_thread_states parent
            JOIN workbench_thread_lifecycle parent_lifecycle ON parent_lifecycle.thread_id = parent.thread_id
            JOIN workbench_thread_states parent_observation ON parent_observation.thread_id = parent.thread_id
            WHERE parent.thread_id = child.parent_thread_id AND parent.archived = 0
              AND (parent_observation.provider_observed = 1 OR parent_lifecycle.settled = 1)
              AND (parent_lifecycle.settled = 0 OR parent_lifecycle.lifecycle_kind = 'completed')
          ))
        )`;
        parameters.push(query.projectId);
        break;
      case "project":
        where = "thread.project_id = ?";
        parameters.push(query.projectId);
        break;
      case "gitRetention":
        where = `thread.project_id = ? AND lifecycle.settled = 1 AND retention.settled_at <= ?
          AND (retention.git_history_cleaned_at IS NULL OR retention.git_history_cleaned_at < retention.settled_at)`;
        parameters.push(query.projectId, query.settledBefore);
        break;
    }
    const rows = this.database.prepare(`${SELECT_THREAD_STATES} WHERE ${where}
      ORDER BY COALESCE(top.order_at, state.activity_at) DESC, state.thread_id
    `).all(...parameters) as ThreadStateRow[];
    return rows.map((row) => this.readThreadState(row));
  }

  readProjectActivity(projectId: ProjectId): number | null {
    return (this.database.prepare(`
      SELECT MAX(state.activity_at) AS activity_at FROM workbench_thread_states state
      JOIN workbench_threads thread ON thread.id = state.thread_id WHERE thread.project_id = ?
    `).get(projectId) as { activity_at: number | null }).activity_at;
  }

  readSnoozeSources(targetThreadId: WorkbenchThreadId): Array<{ projectId: ProjectId; threadId: WorkbenchThreadId }> {
    return this.database.prepare(`
      SELECT thread.project_id AS projectId, dependency.source_thread_id AS threadId
      FROM workbench_thread_snooze_dependencies dependency
      JOIN workbench_threads thread ON thread.id = dependency.source_thread_id
      WHERE dependency.target_thread_id = ?
    `).all(targetThreadId) as Array<{ projectId: ProjectId; threadId: WorkbenchThreadId }>;
  }

  readNextArchiveEligibility(): number | null {
    const row = this.database.prepare(`
      SELECT MIN(state.activity_at) AS activity_at FROM workbench_thread_states state
      JOIN workbench_top_level_thread_states top ON top.thread_id = state.thread_id
      JOIN workbench_thread_lifecycle lifecycle ON lifecycle.thread_id = state.thread_id
      WHERE top.archived = 0 AND top.pinned = 0 AND lifecycle.settled = 1
    `).get() as { activity_at: number | null };
    return row.activity_at;
  }

  readArchiveEligible(activeBefore: number): Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }> {
    if (!Number.isSafeInteger(activeBefore)) throw new Error("Archive eligibility boundary must be an integer timestamp.");
    const rows = this.database.prepare(`${SELECT_THREAD_STATES}
      WHERE top.archived = 0 AND top.pinned = 0 AND lifecycle.settled = 1 AND state.activity_at <= ?
      ORDER BY state.activity_at, state.thread_id
    `).all(activeBefore) as ThreadStateRow[];
    return rows.map(row => ({ projectId: row.project_id, record: this.readThreadState(row) }));
  }

  writeRecords(records: readonly WorkbenchThreadStateRecord[]) {
    this.database.transaction(() => {
      for (const record of records) this.writeThreadIdentityState(record);
      for (const record of records) this.writeThreadState(record);
    })();
  }

  private writeThreadIdentityState(record: WorkbenchThreadStateRecord) {
    const threadId = record.identity.threadId;
    const existing = this.database.prepare("SELECT thread_kind FROM workbench_thread_states WHERE thread_id = ?")
      .get(threadId) as { thread_kind: "topLevel" | "subagent" } | undefined;
    const threadKind = record.entryKind === "thread" ? "topLevel" : "subagent";
    if (existing?.thread_kind === "subagent" && threadKind !== "subagent") {
      throw new Error("A subagent cannot be replaced by a provider discovery row.");
    }
    if (existing?.thread_kind === "topLevel" && threadKind === "subagent") {
      this.database.prepare("DELETE FROM workbench_top_level_thread_states WHERE thread_id = ?").run(threadId);
    }
    if (record.entryKind === "subagent" && record.lifecycle.settled && record.pinned) {
      throw new Error("Settled subagent cannot remain pinned.");
    }
    this.writeDomainFact("workbench_thread_states", ["thread_id"], {
      thread_id: threadId, thread_kind: threadKind, harness_id: record.identity.harness,
      title: record.title, activity_at: record.activityAt, provider_observed: Number(record.providerObserved !== false),
    });
    if (record.entryKind === "thread") {
      this.writeDomainFact("workbench_top_level_thread_states", ["thread_id"], {
        thread_id: threadId, thread_kind: threadKind, archived: Number(record.metadata.archived),
        pinned: Number(record.metadata.pinned), snoozed: Number(record.metadata.snoozed), order_at: record.orderAt ?? null,
      });
    } else {
      const owner = this.database.prepare("SELECT project_id FROM workbench_threads WHERE id = ?")
        .get(threadId) as { project_id: string };
      if (owner.project_id !== record.projectId) throw new Error("Subagent state belongs to another project.");
      this.writeDomainFact("workbench_subagent_thread_states", ["thread_id"], {
        thread_id: threadId, thread_kind: threadKind, parent_thread_id: record.parentThreadId,
        cwd: record.cwd, name: record.name, profile_id: record.profileId, profile_name: record.profileName,
        direct_subagent_index: record.directSubagentIndex ?? 0, created_at: record.createdAt,
        updated_at: record.updatedAt, pinned: Number(record.pinned),
      });
    }
  }

  private writeThreadState(record: WorkbenchThreadStateRecord) {
    const threadId = record.identity.threadId;
    const lifecycle = WorkbenchThreadLifecycleSchema.parse(record.lifecycle);
    const agent = "agent" in lifecycle ? lifecycle.agent : undefined;
    const lifecycleFacts = {
      thread_id: threadId, lifecycle_kind: lifecycle.kind, reason: lifecycle.reason, settled: Number(lifecycle.settled),
      turn_id: "turnId" in lifecycle ? lifecycle.turnId : agent?.turnId ?? null,
      request_key: "requestKey" in lifecycle ? lifecycle.requestKey : null,
      agent_status: agent?.agentStatus ?? null,
    };
    const previousLifecycle = this.database.prepare(`
      SELECT thread_id, lifecycle_kind, reason, settled, turn_id, request_key, agent_status
      FROM workbench_thread_lifecycle WHERE thread_id = ?
    `).get(threadId);
    if (!isDeepStrictEqual(previousLifecycle, lifecycleFacts)) {
      this.writeDomainFact("workbench_thread_lifecycle", ["thread_id"], { ...lifecycleFacts, updated_at: record.activityAt });
    }
    this.writeDomainFact("workbench_thread_retention", ["thread_id"], {
      thread_id: threadId, settled_at: record.settledAt ?? null, git_history_cleaned_at: record.gitHistoryCleanedAt ?? null,
      mcp_generation: record.mcpGeneration ?? null,
    });
    if (record.profile) {
      this.writeDomainFact("workbench_thread_profiles", ["thread_id"], {
        thread_id: threadId, ...profileRow(WorkbenchComposerProfileSelectionSchema.parse(record.profile)),
      });
    } else {
      this.database.prepare("DELETE FROM workbench_thread_profiles WHERE thread_id = ?").run(threadId);
    }
    if (record.snoozedUntil) {
      const target = this.database.prepare(`
        SELECT thread.project_id, state.harness_id FROM workbench_threads thread
        JOIN workbench_thread_states state ON state.thread_id = thread.id WHERE thread.id = ?
      `).get(record.snoozedUntil.identity.threadId) as { project_id: string; harness_id: string } | undefined;
      if (!target || target.project_id !== record.snoozedUntil.projectId || target.harness_id !== record.snoozedUntil.identity.harness) {
        throw new Error("Snooze dependency does not match its canonical thread.");
      }
      this.writeDomainFact("workbench_thread_snooze_dependencies", ["source_thread_id"], {
        source_thread_id: threadId, target_thread_id: record.snoozedUntil.identity.threadId,
      });
    } else {
      this.database.prepare("DELETE FROM workbench_thread_snooze_dependencies WHERE source_thread_id = ?").run(threadId);
    }
    const observations = {
      ...(record.gitArc === undefined ? {} : { gitArc: record.gitArc }),
      ...(record.gitArcPlan === undefined ? {} : { gitArcPlan: record.gitArcPlan }),
    };
    if (!isDeepStrictEqual(this.git.read(threadId), observations)) this.git.replace(threadId, observations);
    const requestedQuestionnaires = {
      pending: record.pendingQuestionnaire ?? null, history: record.questionnaireHistory ?? [],
    };
    if (!isDeepStrictEqual(this.questionnaires.read(threadId), requestedQuestionnaires)) {
      this.questionnaires.replace(threadId, requestedQuestionnaires);
    }
    if (record.titleHistory !== undefined) {
      const titles = new Map(record.titleHistory.map((entry) => [entry.title, entry.usedAt]));
      if (titles.size !== record.titleHistory.length) throw new Error("Thread title history contains duplicate titles.");
      const previous = this.database.prepare("SELECT title FROM workbench_thread_title_history WHERE thread_id = ?")
        .all(threadId) as Array<{ title: string }>;
      for (const entry of previous) {
        if (!titles.has(entry.title)) this.database.prepare("DELETE FROM workbench_thread_title_history WHERE thread_id = ? AND title = ?")
          .run(threadId, entry.title);
      }
      for (const [title, usedAt] of titles) {
        this.writeDomainFact("workbench_thread_title_history", ["thread_id", "title"], {
          thread_id: threadId, title, used_at: usedAt,
        });
      }
    }
  }

  private writeDomainFact(table: string, keys: readonly string[], row: SqlRow) {
    const previous = this.database.prepare(`SELECT * FROM ${table} WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`)
      .get(...keys.map((key) => row[key]));
    if (isDeepStrictEqual(previous, row)) return;
    const columns = Object.keys(row);
    const updated = columns.filter((column) => !keys.includes(column));
    this.database.prepare(`
      INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(${keys.join(",")}) DO UPDATE SET ${updated.map((column) => `${column} = excluded.${column}`).join(",")}
    `).run(...columns.map((column) => row[column]));
  }

  private readThreadState(row: ThreadStateRow): WorkbenchThreadStateRecord {
    const lifecycle = WorkbenchThreadLifecycleSchema.parse({
      kind: row.lifecycle_kind, reason: row.reason, settled: Boolean(row.settled),
      ...(row.agent_status === null ? {} : {
        agent: { agentStatus: row.agent_status, ...(row.turn_id === null ? {} : { turnId: row.turn_id }) },
      }),
      ...(row.turn_id !== null && row.agent_status === null ? { turnId: row.turn_id } : {}),
      ...(row.request_key === null ? {} : { requestKey: row.request_key }),
    });
    const profile = this.database.prepare("SELECT * FROM workbench_thread_profiles WHERE thread_id = ?").get(row.thread_id) as {
      selection_kind: "custom" | "profile"; profile_id: string | null;
      agent_path: string | null; agent_source: "library" | "project" | null; harness_id: WorkbenchHarness;
      model: string; reasoning_effort: string | null; service_tier: "fast" | null; context_window_tokens: number | null;
    } | undefined;
    const questionnaires = this.questionnaires.read(row.thread_id);
    const titles = this.database.prepare(`
      SELECT title, used_at FROM workbench_thread_title_history WHERE thread_id = ? ORDER BY used_at DESC, title
    `).all(row.thread_id) as Array<{ title: string; used_at: number }>;
    const dependency = this.database.prepare(`
      SELECT target.thread_id, target.harness_id, thread.project_id
      FROM workbench_thread_snooze_dependencies dependency
      JOIN workbench_thread_states target ON target.thread_id = dependency.target_thread_id
      JOIN workbench_threads thread ON thread.id = target.thread_id WHERE dependency.source_thread_id = ?
    `).get(row.thread_id) as { thread_id: WorkbenchThreadId; harness_id: WorkbenchHarness; project_id: ProjectId } | undefined;
    const common = {
      identity: { harness: row.harness_id, threadId: row.thread_id }, title: row.title,
      activityAt: row.activity_at, lifecycle, providerObserved: Boolean(row.provider_observed),
      settledAt: row.settled_at, gitHistoryCleanedAt: row.git_history_cleaned_at, mcpGeneration: row.mcp_generation,
      titleHistory: titles.map((title) => ({ title: title.title, usedAt: title.used_at })),
      profile: profile ? WorkbenchComposerProfileSelectionSchema.parse({
        kind: profile.selection_kind, ...(profile.selection_kind === "profile" ? { profileId: profile.profile_id } : {}),
        settings: {
          harness: profile.harness_id, agentPath: profile.agent_path, agentSource: profile.agent_source,
          model: profile.model, reasoningEffort: profile.reasoning_effort, serviceTier: profile.service_tier,
          ...(profile.context_window_tokens !== null ? { contextWindowTokens: profile.context_window_tokens } : {}),
        },
      }) : null,
      snoozedUntil: dependency ? {
        identity: { harness: dependency.harness_id, threadId: dependency.thread_id }, projectId: dependency.project_id,
      } : null,
      pendingQuestionnaire: questionnaires.pending, questionnaireHistory: questionnaires.history,
      ...this.git.read(row.thread_id),
    };
    if (row.thread_kind === "topLevel") {
      if (row.archived === null || row.pinned === null || row.snoozed === null) throw new Error("Top-level thread metadata is incomplete.");
      return {
        ...common, entryKind: "thread", ...(row.order_at === null ? {} : { orderAt: row.order_at }),
        metadata: row.archived
          ? { archived: true, pinned: false, snoozed: false }
          : { archived: false, pinned: Boolean(row.pinned), snoozed: Boolean(row.snoozed) },
      };
    }
    if (row.parent_thread_id === null || row.cwd === null || row.name === null || row.profile_id === null
      || row.profile_name === null || row.direct_subagent_index === null || row.created_at === null
      || row.updated_at === null || row.child_pinned === null) throw new Error("Subagent thread metadata is incomplete.");
    if (lifecycle.settled && row.child_pinned) throw new Error("Settled subagent cannot remain pinned.");
    return {
      ...common, entryKind: "subagent", parentThreadId: row.parent_thread_id, projectId: row.project_id,
      cwd: row.cwd, name: row.name, profileId: row.profile_id, profileName: row.profile_name,
      directSubagentIndex: row.direct_subagent_index, createdAt: row.created_at,
      updatedAt: row.updated_at, pinned: Boolean(row.child_pinned),
    };
  }

  private insert(table: string, row: SqlRow) {
    const columns = Object.keys(row);
    this.database.prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...columns.map((column) => row[column]));
  }

}
