/*
 * Exports:
 * - WorkbenchComposerProfileDatabase: shared database worker port.
 * - default WorkbenchComposerProfileStore: own durable named profiles and ordered mutations.
 */
import type { WorkbenchComposerProfile } from "workbench-shared/types";
import { deleteRows, selectRows, updateRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import type { SelectRow } from "workbench-shared/database/schema/schema-definition";
import { applyComposerProfileMutation, normalizeComposerProfile, normalizeComposerProfileMutation } from "workbench-shared/workbench/state/composer-profile-state";
import { composerProfiles } from "./lib/workbench/database/schema/composer-profile-schema";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import { projectTables } from "workbench-shared/workbench/database/schema/project-schema";

export interface WorkbenchComposerProfileDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

function row(profile: WorkbenchComposerProfile): SelectRow<typeof composerProfiles> {
  return {
    id: profile.id, name: profile.name, description: profile.description ?? null,
    agent_path: profile.agentPath, agent_source: profile.agentSource, harness: profile.harness,
    model: profile.model, reasoning_effort: profile.reasoningEffort, service_tier: profile.serviceTier,
    context_window_tokens: profile.contextWindowTokens ?? null,
    scope_kind: profile.scope.kind, scope_project_id: profile.scope.kind === "project" ? profile.scope.projectId : null,
    created_at: profile.createdAt, updated_at: profile.updatedAt,
    last_used_at: profile.lastUsedAt ?? null,
  };
}

function fromRow(value: SelectRow<typeof composerProfiles>): WorkbenchComposerProfile {
  const profile = normalizeComposerProfile({
    id: value.id, name: value.name, description: value.description,
    agentPath: value.agent_path, agentSource: value.agent_source, harness: value.harness,
    model: value.model, reasoningEffort: value.reasoning_effort, serviceTier: value.service_tier,
    ...(value.context_window_tokens !== null ? { contextWindowTokens: value.context_window_tokens } : {}),
    scope: value.scope_kind === "global" ? { kind: "global" } : { kind: "project", projectId: value.scope_project_id },
    createdAt: value.created_at, updatedAt: value.updated_at,
  });
  if (!profile) throw new Error("Stored composer profile is invalid.");
  return value.last_used_at === null ? profile : { ...profile, lastUsedAt: value.last_used_at };
}

export default class WorkbenchComposerProfileStore {
  private closed = false;
  private readonly closedError = new Error("Composer profile store is closed.");
  private pending: Promise<unknown> | null = null;
  private pendingWrite: Promise<{ changes: number }> | null = null;
  private startup: Promise<void> | null = null;

  constructor(private readonly database: WorkbenchComposerProfileDatabase) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError);
    this.startup ??= this.enqueue(async () => { await this.readProfiles(); });
    return this.startup;
  }

  read() {
    const ready = this.start();
    const result = this.enqueue(async () => {
      await ready;
      return { profiles: await this.readProfiles() };
    }, true);
    return Promise.all([ready, result]).then(([, payload]) => payload);
  }

  mutate(value: unknown, validate?: (profile: WorkbenchComposerProfile, previous: WorkbenchComposerProfile | null) => Promise<void>) {
    const ready = this.start();
    const result = this.enqueue(async () => {
      await ready;
      const mutation = normalizeComposerProfileMutation(value);
      if (!mutation) throw new Error("A valid composer profile mutation is required.");
      const previous = await this.readProfiles();
      const profiles = await this.canonicalProfiles(applyComposerProfileMutation(previous, mutation).map((profile) => {
        const stored = previous.find((entry) => entry.id === profile.id);
        // The upsert deliberately preserves the original creation time.
        return stored ? { ...profile, createdAt: stored.createdAt, ...(stored.lastUsedAt != null ? { lastUsedAt: stored.lastUsedAt } : {}) } : profile;
      }).sort((left, right) => left.createdAt - right.createdAt || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))));
      const profile = mutation.kind === "upsert" ? profiles.find((entry) => entry.id === mutation.profile.id) : null;
      if (profile && validate) await validate(profile, previous.find((entry) => entry.id === profile.id) ?? null);
      await this.write([
        ...this.projectAdmissions(profile ? [profile] : []),
        ...(profile ? [upsertRow(workbenchHarnesses, { id: profile.harness }, { conflictColumns: ["id"], updateColumns: ["id"] })] : []),
        mutation.kind === "delete"
          ? deleteRows(composerProfiles, { id: mutation.profileId })
          : upsertRow(composerProfiles, row(profile!), {
            conflictColumns: ["id"],
            updateColumns: ["name", "description", "agent_path", "agent_source", "harness", "model", "reasoning_effort", "service_tier", "context_window_tokens", "scope_kind", "scope_project_id", "created_at", "updated_at"],
          }),
      ]);
      return { profiles };
    });
    return Promise.all([ready, result]).then(([, payload]) => payload);
  }

  async dispose() {
    this.closed = true;
    await this.pendingWrite;
  }

  recordUsage(profileId: string, at: number) {
    if (!Number.isSafeInteger(at) || at < 0) return Promise.reject(new Error("Profile usage requires a valid timestamp."));
    const ready = this.start();
    const result = this.enqueue(async () => {
      await ready;
      const [profile] = await this.database.query(selectRows(composerProfiles, { where: { id: profileId } }));
      this.assertOpen();
      if (!profile || (profile.last_used_at !== null && profile.last_used_at >= at)) return;
      // Compare-and-set also fences another store instance without resurrecting deletions.
      await this.write([updateRows(composerProfiles, { last_used_at: at }, { id: profileId, last_used_at: profile.last_used_at })]);
    });
    return Promise.all([ready, result]).then(() => undefined);
  }

  private async readProfiles() {
    const profiles = await this.database.query(selectRows(composerProfiles, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
    }));
    this.assertOpen();
    return profiles.map(fromRow);
  }

  private async canonicalProfiles(profiles: WorkbenchComposerProfile[]) {
    if (!profiles.some(profile => profile.scope.kind === "project")) return profiles;
    const aliases = await this.database.query(selectRows(projectTables.aliases));
    this.assertOpen();
    const mapping = new Map(aliases.map(alias => [alias.alias, alias.project_id]));
    return profiles.map(profile => profile.scope.kind === "project" ? {
      ...profile, scope: { ...profile.scope, projectId: mapping.get(profile.scope.projectId) ?? profile.scope.projectId },
    } : profile);
  }

  private projectAdmissions(profiles: readonly WorkbenchComposerProfile[]) {
    const ids = new Set(profiles.flatMap(profile => profile.scope.kind === "project" ? [profile.scope.projectId] : []));
    return [...ids].map(id => upsertRow(projectTables.projects, { id }, { conflictColumns: ["id"], updateColumns: ["id"] }));
  }

  private enqueue<Result>(operation: () => Promise<Result>, requirePriorSuccess = false): Promise<Result> {
    if (this.closed) return Promise.reject(this.closedError);
    const previous = this.pending ?? Promise.resolve();
    const result = (requirePriorSuccess ? previous : previous.catch(() => undefined)).then(() => {
      this.assertOpen();
      return operation();
    });
    this.pending = result;
    return result.finally(() => { if (this.pending === result) this.pending = null; });
  }

  private async write(statements: readonly WorkbenchDatabaseMutation[]) {
    this.assertOpen();
    const pending = this.database.executeTransaction(statements);
    this.pendingWrite = pending;
    try { return await pending; }
    finally { if (this.pendingWrite === pending) this.pendingWrite = null; }
  }

  private assertOpen() {
    if (this.closed) throw this.closedError;
  }
}
