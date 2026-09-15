/*
 * Exports:
 * - default WorkbenchAppStateController: own app-state bootstrap, schema capability, revision reads, and serialized domain mutations.
 */
import {
  type WorkbenchProjectRemap,
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateMutation,
  type WorkbenchClientStateRecord,
  type WorkbenchClientStateResponse,
  type WorkbenchClientStateRows,
  type WorkbenchGlobalPreference,
  type WorkbenchProjectPreference,
  type WorkbenchSidebarPreference,
} from "workbench-shared/state/workbench-client-state";
import { isDeepStrictEqual } from "node:util";
import { projectWorkbenchClientStateRows, workbenchClientStateRecordIdentity as recordIdentity } from "workbench-shared/state/workbench-client-state-projection";
import {
  deleteRows,
  insertRow,
  selectRows,
  updateRows,
  upsertRow,
  type WorkbenchDatabaseMutation,
} from "workbench-shared/database/workbench-database-statements";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { appStateClientTables, appStateSchema, appStateTables } from "workbench-shared/state/workbench-app-state-schema";

type ScalarPreference = WorkbenchGlobalPreference | WorkbenchProjectPreference | WorkbenchSidebarPreference;
type GlobalPreferenceForKey<TKey extends WorkbenchGlobalPreference["key"]> = Extract<
  WorkbenchGlobalPreference,
  { key: TKey }
>;

function scalarColumns(preference: ScalarPreference) {
  return {
    boolean_value: typeof preference.value === "boolean" ? Number(preference.value) as 0 | 1 : null,
    // Font sizes use hundredths of a rem in the STRICT integer storage slot.
    integer_value: typeof preference.value === "number"
      ? preference.key === "editorFontSize" ? Math.round(preference.value * 100) : preference.value
      : null,
    text_value: typeof preference.value === "string" ? preference.value : null,
  };
}

export default class WorkbenchAppStateController {
  readonly #repository: WorkbenchAppStateRepository;
  #mutationQueue = Promise.resolve();

  constructor(repository = new WorkbenchAppStateRepository()) {
    this.#repository = repository;
  }

  get daemonRegistrationId() {
    return this.#repository.daemonRegistrationId;
  }

  start() {
    return this.#repository.start();
  }

  close() {
    return this.#repository.close();
  }

  read(sinceRevision?: number): WorkbenchClientStateResponse {
    const version = this.#repository.currentVersion();
    const canUseDelta = sinceRevision !== undefined
      && sinceRevision >= version.oldestAvailableRevision
      && sinceRevision <= version.revision;
    return {
      daemonRegistrationId: this.daemonRegistrationId,
      kind: canUseDelta ? "delta" : "snapshot",
      rows: this.#readRows(canUseDelta ? sinceRevision : -1),
      schemaVersion: appStateSchema.currentVersion,
      ...version,
    };
  }

  readGlobalPreference<TKey extends WorkbenchGlobalPreference["key"]>(
    key: TKey,
  ): GlobalPreferenceForKey<TKey>["value"] | null;
  readGlobalPreference(
    key: WorkbenchGlobalPreference["key"],
  ): WorkbenchGlobalPreference["value"] | null {
    for (const change of projectWorkbenchClientStateRows(this.read().rows)) {
      if (
        change.change === "upsert"
        && change.record.kind === "globalPreference"
        && change.record.preference.key === key
      ) {
        return change.record.preference.value;
      }
    }
    return null;
  }

  mutate(mutation: WorkbenchClientStateMutation) {
    const operation = this.#mutationQueue.then(() => {
      const canonical = mutation.action === "put"
        ? { ...mutation, record: this.#canonicalProject(mutation.record) }
        : { ...mutation, identity: this.#canonicalProject(mutation.identity) };
      const revision = this.#repository.commit((nextRevision) => this.#buildMutation(canonical, nextRevision));
      return this.read(revision - 1);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  readProjectAliases() {
    return this.#repository.readProjectAliases();
  }

  remapProjects(request: WorkbenchProjectRemap) {
    const operation = this.#mutationQueue.then(() => {
      const revision = this.#repository.remapProjects(request, (aliases, revision) => {
        const mapping = new Map(aliases.map(alias => [alias.alias, alias.projectId]));
        const changes = projectWorkbenchClientStateRows(this.read().rows);
        const identities = changes.map(change => change.change === "upsert" ? recordIdentity(change.record) : change.identity);
        const moved: WorkbenchClientStateIdentity[] = [];
        const mutations: WorkbenchDatabaseMutation[] = [];
        for (const change of changes) {
          if (change.change === "upsert" && change.record.kind === "lastLaunchTarget") {
            const projectId = mapping.get(change.record.projectId);
            if (projectId && change.record.daemonRegistrationId === request.daemonRegistrationId) {
              mutations.push(...this.#put({ ...change.record, projectId }, revision));
            }
            continue;
          }
          const value = change.change === "upsert" ? change.record : change.identity;
          if (!("projectId" in value) || value.daemonRegistrationId !== request.daemonRegistrationId) continue;
          const projectId = mapping.get(value.projectId);
          if (!projectId) continue;
          const next = { ...value, projectId };
          const identity = change.change === "upsert" ? recordIdentity(next as WorkbenchClientStateRecord) : next as WorkbenchClientStateIdentity;
          if (identities.some(existing => isDeepStrictEqual(existing, identity)) || moved.some(existing => isDeepStrictEqual(existing, identity))) {
            throw new Error("Project remap conflicts with existing saved state.");
          }
          moved.push(identity);
          if (change.change === "upsert") {
            mutations.push(...this.#put({ ...change.record, projectId } as WorkbenchClientStateRecord, revision));
            mutations.push(...this.#delete(recordIdentity(change.record), revision));
          }
        }
        return mutations;
      });
      return this.read(revision - 1);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #canonicalProject<Value extends WorkbenchClientStateRecord | WorkbenchClientStateIdentity>(value: Value): Value {
    if (!("projectId" in value)) return value;
    return { ...value, projectId: this.#repository.resolveProjectId(value.daemonRegistrationId, value.projectId) };
  }

  #readRows(sinceRevision: number): WorkbenchClientStateRows {
    const changed = <Row extends { revision: number }>(rows: Row[]) => (
      rows.filter((row) => row.revision > sinceRevision)
    );
    return {
      composerDraftAttachments: this.#repository.query(selectRows(appStateClientTables.composerDraftAttachments)),
      composerDrafts: changed(this.#repository.query(selectRows(appStateClientTables.composerDrafts))),
      fileDrafts: changed(this.#repository.query(selectRows(appStateClientTables.fileDrafts))),
      globalPreferences: changed(this.#repository.query(selectRows(appStateClientTables.globalPreferences))),
      modelPreferences: changed(this.#repository.query(selectRows(appStateClientTables.modelPreferences))),
      lastLaunchTarget: changed(this.#repository.query(selectRows(appStateClientTables.lastLaunchTarget))),
      projectExpandedDirectories: changed(this.#repository.query(selectRows(appStateClientTables.projectExpandedDirectories))),
      projectPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectPreferences))),
      projectSidebarFolders: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarFolders))),
      projectSidebarPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarPreferences))),
      questionnaireDraftAnswers: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftAnswers)),
      questionnaireDraftAttachments: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftAttachments)),
      questionnaireDraftSelections: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftSelections)),
      questionnaireDrafts: changed(this.#repository.query(selectRows(appStateClientTables.questionnaireDrafts))),
    };
  }

  #buildMutation(mutation: WorkbenchClientStateMutation, revision: number): WorkbenchDatabaseMutation[] {
    if (mutation.action === "put") return this.#put(mutation.record, revision);
    return this.#delete(mutation.identity, revision);
  }

  #put(record: WorkbenchClientStateRecord, revision: number): WorkbenchDatabaseMutation[] {
    switch (record.kind) {
      case "modelPreference":
        return [
          upsertRow(appStateTables.workbenchHarnesses, { id: record.harness }, { conflictColumns: ["id"], updateColumns: ["id"] }),
          upsertRow(appStateTables.modelPreferences, {
          harness: record.harness, model_id: record.modelId, favourite: Number(record.favourite) as 0 | 1, deleted: 0, revision,
          }, { conflictColumns: ["harness", "model_id"], updateColumns: ["favourite", "deleted", "revision"] }),
        ];
      case "globalPreference":
        return [upsertRow(appStateTables.globalPreferences, {
          ...scalarColumns(record.preference),
          deleted: 0,
          key: record.preference.key,
          revision,
        }, { conflictColumns: ["key"], updateColumns: ["boolean_value", "integer_value", "text_value", "deleted", "revision"] })];
      case "projectPreference":
        return [upsertRow(appStateTables.projectPreferences, {
          ...scalarColumns(record.preference),
          daemon_registration_id: record.daemonRegistrationId,
          deleted: 0,
          enabled: Number(record.preference.enabled) as 0 | 1,
          key: record.preference.key,
          project_id: record.projectId,
          revision,
        }, { conflictColumns: ["daemon_registration_id", "project_id", "key"], updateColumns: ["enabled", "boolean_value", "integer_value", "text_value", "deleted", "revision"] })];
      case "sidebarPreference":
        return [upsertRow(appStateTables.projectSidebarPreferences, {
          boolean_value: typeof record.preference.value === "boolean" ? Number(record.preference.value) as 0 | 1 : null,
          daemon_registration_id: record.daemonRegistrationId,
          deleted: 0,
          integer_value: typeof record.preference.value === "number" ? record.preference.value : null,
          key: record.preference.key,
          project_id: record.projectId,
          revision,
        }, { conflictColumns: ["daemon_registration_id", "project_id", "key"], updateColumns: ["boolean_value", "integer_value", "deleted", "revision"] })];
      case "sidebarFolder":
        return [upsertRow(appStateTables.projectSidebarFolders, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, folder_id: record.folderId,
          project_id: record.projectId, revision, scope: record.scope,
        }, { conflictColumns: ["daemon_registration_id", "project_id", "scope", "folder_id"], updateColumns: ["deleted", "revision"] })];
      case "expandedDirectory":
        return [upsertRow(appStateTables.projectExpandedDirectories, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, path: record.path,
          project_id: record.projectId, revision,
        }, { conflictColumns: ["daemon_registration_id", "project_id", "path"], updateColumns: ["deleted", "revision"] })];
      case "lastLaunchTarget":
        return [upsertRow(appStateTables.lastLaunchTarget, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, id: "singleton",
          project_id: record.projectId, revision,
        }, { conflictColumns: ["id"], updateColumns: ["daemon_registration_id", "project_id", "deleted", "revision"] })];
      case "fileDraft":
        return [upsertRow(appStateTables.fileDrafts, {
          baseline_content: record.value.baselineContent,
          content: record.value.content,
          daemon_registration_id: record.daemonRegistrationId,
          deleted: 0,
          expected_mtime_ms: record.value.expectedMtimeMs,
          head_content: record.value.headContent,
          mode: record.value.mode,
          path: record.path,
          project_id: record.projectId,
          revision,
        }, { conflictColumns: ["daemon_registration_id", "project_id", "path"], updateColumns: ["baseline_content", "content", "expected_mtime_ms", "head_content", "mode", "deleted", "revision"] })];
      case "composerDraft": {
        const identity = recordIdentity(record);
        return [
          deleteRows(appStateTables.composerDraftAttachments, {
            daemon_registration_id: record.daemonRegistrationId,
            project_id: record.projectId,
            thread_id: record.threadId,
          }),
          upsertRow(appStateTables.composerDrafts, {
            daemon_registration_id: record.daemonRegistrationId,
            deleted: 0,
            project_id: record.projectId,
            revision,
            text: record.value.text,
            thread_id: record.threadId,
            updated_at: record.value.updatedAt,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id"], updateColumns: ["text", "updated_at", "deleted", "revision"] }),
          ...record.value.attachments.map((attachment) => insertRow(appStateTables.composerDraftAttachments, {
            daemon_registration_id: record.daemonRegistrationId,
            id: attachment.id,
            owner_deleted: 0,
            project_id: record.projectId,
            thread_id: record.threadId,
            url: attachment.url,
          })),
        ];
      }
      case "questionnaireDraft":
        return [
          ...this.#deleteQuestionnaireChildren(record),
          upsertRow(appStateTables.questionnaireDrafts, {
            daemon_registration_id: record.daemonRegistrationId,
            deleted: 0,
            project_id: record.projectId,
            request_key: record.requestKey,
            revision,
            thread_id: record.threadId,
            updated_at: record.value.updatedAt,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "request_key"], updateColumns: ["updated_at", "deleted", "revision"] }),
          ...Object.entries(record.value.customValues).map(([key, answer]) => insertRow(appStateTables.questionnaireDraftAnswers, {
            answer, daemon_registration_id: record.daemonRegistrationId, key, owner_deleted: 0,
            project_id: record.projectId, request_key: record.requestKey, thread_id: record.threadId,
          })),
          ...Object.entries(record.value.selectedValues).flatMap(([key, values]) => values.map((value) => insertRow(appStateTables.questionnaireDraftSelections, {
            daemon_registration_id: record.daemonRegistrationId, key, owner_deleted: 0,
            project_id: record.projectId, request_key: record.requestKey, thread_id: record.threadId, value,
          }))),
          ...record.value.attachments.map((attachment) => insertRow(appStateTables.questionnaireDraftAttachments, {
            daemon_registration_id: record.daemonRegistrationId, key: attachment.id, owner_deleted: 0,
            project_id: record.projectId, request_key: record.requestKey, thread_id: record.threadId, url: attachment.url,
          })),
        ];
    }
  }

  #delete(identity: WorkbenchClientStateIdentity, revision: number): WorkbenchDatabaseMutation[] {
    switch (identity.kind) {
      case "modelPreference":
        return [updateRows(appStateTables.modelPreferences, { deleted: 1, revision }, {
          harness: identity.harness, model_id: identity.modelId,
        })];
      case "globalPreference":
        return [updateRows(appStateTables.globalPreferences, {
          boolean_value: null, deleted: 1, integer_value: null, revision, text_value: null,
        }, { key: identity.key })];
      case "lastLaunchTarget":
        return [updateRows(appStateTables.lastLaunchTarget, { deleted: 1, project_id: "", revision }, { id: "singleton" })];
      case "projectPreference":
        return [updateRows(appStateTables.projectPreferences, {
          boolean_value: null, deleted: 1, enabled: null, integer_value: null, revision, text_value: null,
        }, { daemon_registration_id: identity.daemonRegistrationId, key: identity.key, project_id: identity.projectId })];
      case "sidebarPreference":
        return [updateRows(appStateTables.projectSidebarPreferences, {
          boolean_value: null, deleted: 1, integer_value: null, revision,
        }, { daemon_registration_id: identity.daemonRegistrationId, key: identity.key, project_id: identity.projectId })];
      case "sidebarFolder":
        return [updateRows(appStateTables.projectSidebarFolders, { deleted: 1, revision }, {
          daemon_registration_id: identity.daemonRegistrationId, folder_id: identity.folderId,
          project_id: identity.projectId, scope: identity.scope,
        })];
      case "expandedDirectory":
        return [updateRows(appStateTables.projectExpandedDirectories, { deleted: 1, revision }, {
          daemon_registration_id: identity.daemonRegistrationId, path: identity.path, project_id: identity.projectId,
        })];
      case "fileDraft":
        return [updateRows(appStateTables.fileDrafts, {
          baseline_content: null, content: null, deleted: 1, expected_mtime_ms: null,
          head_content: null, mode: null, revision,
        }, { daemon_registration_id: identity.daemonRegistrationId, path: identity.path, project_id: identity.projectId })];
      case "composerDraft":
        return [
          deleteRows(appStateTables.composerDraftAttachments, {
            daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId, thread_id: identity.threadId,
          }),
          updateRows(appStateTables.composerDrafts, { deleted: 1, revision, text: null, updated_at: null }, {
            daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId, thread_id: identity.threadId,
          }),
        ];
      case "questionnaireDraft":
        return [
          ...this.#deleteQuestionnaireChildren(identity),
          updateRows(appStateTables.questionnaireDrafts, { deleted: 1, revision, updated_at: null }, {
            daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId,
            request_key: identity.requestKey, thread_id: identity.threadId,
          }),
        ];
    }
  }

  #deleteQuestionnaireChildren(identity: Extract<
    WorkbenchClientStateIdentity | WorkbenchClientStateRecord,
    { kind: "questionnaireDraft" }
  >): WorkbenchDatabaseMutation[] {
    const where = {
      daemon_registration_id: identity.daemonRegistrationId,
      project_id: identity.projectId,
      request_key: identity.requestKey,
      thread_id: identity.threadId,
    };
    return [
      deleteRows(appStateTables.questionnaireDraftAnswers, where),
      deleteRows(appStateTables.questionnaireDraftSelections, where),
      deleteRows(appStateTables.questionnaireDraftAttachments, where),
    ];
  }
}
