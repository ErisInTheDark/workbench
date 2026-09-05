/*
 * Keywords: composer, profile, sqlite, catalogue, import, queue, lifecycle.
 * Exports:
 * - WorkbenchComposerProfileDatabase: shared database worker port.
 * - default WorkbenchComposerProfileStore: own durable named profiles, import and ordered mutations.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkbenchComposerProfile } from "workbench-shared/types";
import { deleteRows, insertRow, selectRows, upsertRow, type WorkbenchDatabaseMutation, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import type { SelectRow } from "workbench-shared/database/schema/schema-definition";
import { applyComposerProfileMutation, normalizeComposerProfile, normalizeComposerProfileMutation } from "workbench-shared/workbench/state/composer-profile-state";
import { composerProfileImports, composerProfiles } from "../lib/workbench/database/schema/composer-profile-schema";

export interface WorkbenchComposerProfileDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

function row(profile: WorkbenchComposerProfile): SelectRow<typeof composerProfiles> {
  return {
    id: profile.id, name: profile.name, description: profile.description ?? null,
    agent_path: profile.agentPath, agent_source: profile.agentSource, harness: profile.harness,
    model: profile.model, reasoning_effort: profile.reasoningEffort, service_tier: profile.serviceTier,
    scope_kind: profile.scope.kind, scope_project_id: profile.scope.kind === "project" ? profile.scope.projectId : null,
    created_at: profile.createdAt, updated_at: profile.updatedAt,
  };
}

function fromRow(value: SelectRow<typeof composerProfiles>): WorkbenchComposerProfile {
  const profile = normalizeComposerProfile({
    id: value.id, name: value.name, description: value.description,
    agentPath: value.agent_path, agentSource: value.agent_source, harness: value.harness,
    model: value.model, reasoningEffort: value.reasoning_effort, serviceTier: value.service_tier,
    scope: value.scope_kind === "global" ? { kind: "global" } : { kind: "project", projectId: value.scope_project_id },
    createdAt: value.created_at, updatedAt: value.updated_at,
  });
  if (!profile) throw new Error("Stored composer profile is invalid.");
  return profile;
}

export default class WorkbenchComposerProfileStore {
  private closed = false;
  private pending: Promise<unknown> | null = null;
  private startup: Promise<void> | null = null;

  constructor(private readonly storageRoot: string, private readonly database: WorkbenchComposerProfileDatabase) {}

  start(): Promise<void> {
    this.startup ??= this.enqueue(() => this.importLegacy());
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

  mutate(value: unknown) {
    const ready = this.start();
    const result = this.enqueue(async () => {
      await ready;
      const mutation = normalizeComposerProfileMutation(value);
      if (!mutation) throw new Error("A valid composer profile mutation is required.");
      const profiles = applyComposerProfileMutation(await this.readProfiles(), mutation);
      const profile = mutation.kind === "upsert" ? profiles.find((entry) => entry.id === mutation.profile.id) : null;
      await this.database.executeTransaction([
        mutation.kind === "delete"
          ? deleteRows(composerProfiles, { id: mutation.profileId })
          : upsertRow(composerProfiles, row(profile!), {
            conflictColumns: ["id"],
            updateColumns: ["name", "description", "agent_path", "agent_source", "harness", "model", "reasoning_effort", "service_tier", "scope_kind", "scope_project_id", "created_at", "updated_at"],
          }),
      ]);
      return { profiles: await this.readProfiles() };
    });
    return Promise.all([ready, result]).then(([, payload]) => payload);
  }

  async dispose() {
    this.closed = true;
    await this.pending;
  }

  private async readProfiles() {
    return (await this.database.query(selectRows(composerProfiles, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
    }))).map(fromRow);
  }

  private async importLegacy() {
    if ((await this.database.query(selectRows(composerProfileImports, { where: { id: "legacy-json" } }))).length) return;
    let source: string;
    try {
      source = await readFile(path.join(this.storageRoot, ".workbench", "runtime", "composer-profiles.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      source = '{"version":1,"profiles":{}}';
    }
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || !("profiles" in raw) || !raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) {
      throw new Error("Legacy composer profile catalogue is invalid.");
    }
    const profiles = Object.entries(raw.profiles).map(([id, value]) => {
      const profile = normalizeComposerProfile(value);
      if (!profile || profile.id !== id || (profile.scope.kind === "global" && profile.agentSource === "project")) {
        throw new Error("Legacy composer profile entry is invalid.");
      }
      return profile;
    });
    await this.database.executeTransaction([
      ...profiles.map((profile) => insertRow(composerProfiles, row(profile))),
      insertRow(composerProfileImports, { id: "legacy-json" }),
    ]);
  }

  private enqueue<Result>(operation: () => Promise<Result>, requirePriorSuccess = false): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("Composer profile store is closed."));
    const previous = this.pending ?? Promise.resolve();
    const result = (requirePriorSuccess ? previous : previous.catch(() => undefined)).then(operation);
    this.pending = result;
    return result.finally(() => { if (this.pending === result) this.pending = null; });
  }
}
