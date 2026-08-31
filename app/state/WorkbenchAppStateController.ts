/*
 * Exports:
 * - default WorkbenchAppStateController: own app-state bootstrap, revision reads, and serialized domain mutations. Keywords: app, state, controller, revision.
 */
import {
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateMutation,
  type WorkbenchClientStateRecord,
  type WorkbenchClientStateResponse,
  type WorkbenchClientStateRows,
  type WorkbenchGlobalPreference,
  type WorkbenchProjectPreference,
  type WorkbenchSidebarPreference,
} from "workbench-shared/state/workbench-client-state";
import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import {
  deleteRows,
  insertRow,
  selectRows,
  updateRows,
  upsertRow,
  type WorkbenchDatabaseMutation,
} from "workbench-shared/database/workbench-database-statements";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import { appStateClientTables, appStateTables } from "workbench-shared/state/workbench-app-state-schema";

type ScalarPreference = WorkbenchGlobalPreference | WorkbenchProjectPreference | WorkbenchSidebarPreference;
type GlobalPreferenceForKey<TKey extends WorkbenchGlobalPreference["key"]> = Extract<
  WorkbenchGlobalPreference,
  { key: TKey }
>;

function scalarColumns(preference: ScalarPreference) {
  return {
    boolean_value: typeof preference.value === "boolean" ? Number(preference.value) as 0 | 1 : null,
    integer_value: typeof preference.value === "number" ? preference.value : null,
    text_value: typeof preference.value === "string" ? preference.value : null,
  };
}

function recordIdentity(record: WorkbenchClientStateRecord): WorkbenchClientStateIdentity {
  switch (record.kind) {
    case "globalPreference": return { key: record.preference.key, kind: record.kind };
    case "projectPreference": return { daemonRegistrationId: record.daemonRegistrationId, key: record.preference.key, kind: record.kind, projectId: record.projectId };
    case "sidebarPreference": return { daemonRegistrationId: record.daemonRegistrationId, key: record.preference.key, kind: record.kind, projectId: record.projectId };
    case "sidebarFolder": return { daemonRegistrationId: record.daemonRegistrationId, folderId: record.folderId, kind: record.kind, projectId: record.projectId, scope: record.scope };
    case "expandedDirectory": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, path: record.path, projectId: record.projectId };
    case "harnessPreference": return { daemonRegistrationId: record.daemonRegistrationId, harness: record.harness, kind: record.kind };
    case "modelEffort": return { daemonRegistrationId: record.daemonRegistrationId, harness: record.harness, kind: record.kind, model: record.model };
    case "threadServiceTier": return { daemonRegistrationId: record.daemonRegistrationId, harness: record.harness, kind: record.kind, threadId: record.threadId };
    case "newThreadProfilePreference": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, projectId: record.projectId };
    case "draftProfilePreference": return { daemonRegistrationId: record.daemonRegistrationId, draftId: record.draftId, harness: record.harness, kind: record.kind, projectId: record.projectId };
    case "threadProfilePreference": return { daemonRegistrationId: record.daemonRegistrationId, harness: record.harness, kind: record.kind, threadId: record.threadId };
    case "fileDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, path: record.path, projectId: record.projectId };
    case "composerDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, projectId: record.projectId, threadId: record.threadId };
    case "questionnaireDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, projectId: record.projectId, requestKey: record.requestKey, threadId: record.threadId };
    case "lastLaunchTarget": return { kind: record.kind };
  }
}

function customSettingsId(identity: WorkbenchClientStateIdentity) {
  const part = (value: string) => encodeURIComponent(value);
  switch (identity.kind) {
    case "newThreadProfilePreference":
      return `new:${part(identity.daemonRegistrationId)}:${part(identity.projectId)}`;
    case "draftProfilePreference":
      return `draft:${part(identity.daemonRegistrationId)}:${part(identity.projectId)}:${part(identity.harness)}:${part(identity.draftId)}`;
    case "threadProfilePreference":
      return `thread:${part(identity.daemonRegistrationId)}:${part(identity.harness)}:${part(identity.threadId)}`;
    default:
      throw new Error("Custom settings require a profile preference identity.");
  }
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
    this.#repository.close();
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
      ...version,
    };
  }

  readGlobalPreference<TKey extends WorkbenchGlobalPreference["key"]>(
    key: TKey,
  ): GlobalPreferenceForKey<TKey>["value"] | null {
    for (const change of projectWorkbenchClientStateRows(this.read().rows)) {
      if (
        change.change === "upsert"
        && change.record.kind === "globalPreference"
        && change.record.preference.key === key
      ) {
        return change.record.preference.value as GlobalPreferenceForKey<TKey>["value"];
      }
    }
    return null;
  }

  mutate(mutation: WorkbenchClientStateMutation) {
    const operation = this.#mutationQueue.then(() => {
      const revision = this.#repository.commit((nextRevision) => this.#buildMutation(mutation, nextRevision));
      return this.read(revision - 1);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #readRows(sinceRevision: number): WorkbenchClientStateRows {
    const changed = <Row extends { revision: number }>(rows: Row[]) => (
      rows.filter((row) => row.revision > sinceRevision)
    );
    return {
      composerDraftAttachments: this.#repository.query(selectRows(appStateClientTables.composerDraftAttachments)),
      composerDrafts: changed(this.#repository.query(selectRows(appStateClientTables.composerDrafts))),
      composerSettings: this.#repository.query(selectRows(appStateClientTables.composerSettings)),
      draftProfilePreferences: changed(this.#repository.query(selectRows(appStateClientTables.draftProfilePreferences))),
      fileDrafts: changed(this.#repository.query(selectRows(appStateClientTables.fileDrafts))),
      globalPreferences: changed(this.#repository.query(selectRows(appStateClientTables.globalPreferences))),
      harnessModelEfforts: changed(this.#repository.query(selectRows(appStateClientTables.harnessModelEfforts))),
      harnessPreferences: changed(this.#repository.query(selectRows(appStateClientTables.harnessPreferences))),
      lastLaunchTarget: changed(this.#repository.query(selectRows(appStateClientTables.lastLaunchTarget))),
      newThreadProfilePreferences: changed(this.#repository.query(selectRows(appStateClientTables.newThreadProfilePreferences))),
      projectExpandedDirectories: changed(this.#repository.query(selectRows(appStateClientTables.projectExpandedDirectories))),
      projectPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectPreferences))),
      projectSidebarFolders: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarFolders))),
      projectSidebarPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarPreferences))),
      questionnaireDraftAnswers: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftAnswers)),
      questionnaireDraftAttachments: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftAttachments)),
      questionnaireDraftSelections: this.#repository.query(selectRows(appStateClientTables.questionnaireDraftSelections)),
      questionnaireDrafts: changed(this.#repository.query(selectRows(appStateClientTables.questionnaireDrafts))),
      threadProfilePreferences: changed(this.#repository.query(selectRows(appStateClientTables.threadProfilePreferences))),
      threadServiceTiers: changed(this.#repository.query(selectRows(appStateClientTables.threadServiceTiers))),
    };
  }

  #buildMutation(mutation: WorkbenchClientStateMutation, revision: number): WorkbenchDatabaseMutation[] {
    if (mutation.action === "put") return this.#put(mutation.record, revision);
    return this.#delete(mutation.identity, revision);
  }

  #put(record: WorkbenchClientStateRecord, revision: number): WorkbenchDatabaseMutation[] {
    switch (record.kind) {
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
      case "harnessPreference":
        return [upsertRow(appStateTables.harnessPreferences, {
          agent_path: record.agentPath, daemon_registration_id: record.daemonRegistrationId, deleted: 0,
          harness: record.harness, model: record.model, revision, service_tier: record.serviceTier,
        }, { conflictColumns: ["daemon_registration_id", "harness"], updateColumns: ["model", "service_tier", "agent_path", "deleted", "revision"] })];
      case "modelEffort":
        return [upsertRow(appStateTables.harnessModelEfforts, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, harness: record.harness,
          model: record.model, reasoning_effort: record.reasoningEffort, revision,
        }, { conflictColumns: ["daemon_registration_id", "harness", "model"], updateColumns: ["reasoning_effort", "deleted", "revision"] })];
      case "threadServiceTier":
        return [upsertRow(appStateTables.threadServiceTiers, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, harness: record.harness,
          revision, service_tier: record.serviceTier, thread_id: record.threadId,
        }, { conflictColumns: ["daemon_registration_id", "harness", "thread_id"], updateColumns: ["service_tier", "deleted", "revision"] })];
      case "lastLaunchTarget":
        return [upsertRow(appStateTables.lastLaunchTarget, {
          daemon_registration_id: record.daemonRegistrationId, deleted: 0, id: "singleton",
          project_id: record.projectId, revision,
        }, { conflictColumns: ["id"], updateColumns: ["daemon_registration_id", "project_id", "deleted", "revision"] })];
      case "newThreadProfilePreference":
      case "draftProfilePreference":
      case "threadProfilePreference":
        return this.#putProfile(record, revision);
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
      case "harnessPreference":
        return [updateRows(appStateTables.harnessPreferences, {
          agent_path: null, deleted: 1, model: null, revision, service_tier: null,
        }, { daemon_registration_id: identity.daemonRegistrationId, harness: identity.harness })];
      case "modelEffort":
        return [updateRows(appStateTables.harnessModelEfforts, { deleted: 1, reasoning_effort: null, revision }, {
          daemon_registration_id: identity.daemonRegistrationId, harness: identity.harness, model: identity.model,
        })];
      case "threadServiceTier":
        return [updateRows(appStateTables.threadServiceTiers, { deleted: 1, revision, service_tier: null }, {
          daemon_registration_id: identity.daemonRegistrationId, harness: identity.harness, thread_id: identity.threadId,
        })];
      case "newThreadProfilePreference":
      case "draftProfilePreference":
      case "threadProfilePreference":
        return this.#deleteProfile(identity, revision);
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

  #putProfile(
    record: Extract<WorkbenchClientStateRecord, { kind: "draftProfilePreference" | "newThreadProfilePreference" | "threadProfilePreference" }>,
    revision: number,
  ): WorkbenchDatabaseMutation[] {
    const identity = recordIdentity(record);
    const settingsId = customSettingsId(identity);
    const settingsBefore: WorkbenchDatabaseMutation[] = record.value.kind === "custom"
      ? [upsertRow(appStateTables.composerSettings, {
        agent_path: record.value.settings.agentPath,
        agent_source: record.value.settings.agentSource,
        harness: record.value.settings.harness,
        id: settingsId,
        model: record.value.settings.model,
        reasoning_effort: record.value.settings.reasoningEffort,
        revision,
        service_tier: record.value.settings.serviceTier,
      }, { conflictColumns: ["id"], updateColumns: ["agent_path", "agent_source", "harness", "model", "reasoning_effort", "service_tier", "revision"] })]
      : [];
    const cleanupAfter: WorkbenchDatabaseMutation[] = record.value.kind === "daemon-profile"
      ? [deleteRows(appStateTables.composerSettings, { id: settingsId })]
      : [];
    const values = {
      custom_settings_id: record.value.kind === "custom" ? settingsId : null,
      daemon_profile_id: record.value.kind === "daemon-profile" ? record.value.profileId : null,
      daemon_registration_id: record.daemonRegistrationId,
      deleted: 0 as const,
      kind: record.value.kind,
      revision,
    };
    if (record.kind === "newThreadProfilePreference") {
      return [...settingsBefore, upsertRow(appStateTables.newThreadProfilePreferences, {
        ...values, project_id: record.projectId,
      }, { conflictColumns: ["daemon_registration_id", "project_id"], updateColumns: ["kind", "custom_settings_id", "daemon_profile_id", "deleted", "revision"] }), ...cleanupAfter];
    }
    if (record.kind === "draftProfilePreference") {
      return [...settingsBefore, upsertRow(appStateTables.draftProfilePreferences, {
        ...values, draft_id: record.draftId, harness: record.harness, project_id: record.projectId,
      }, { conflictColumns: ["daemon_registration_id", "project_id", "harness", "draft_id"], updateColumns: ["kind", "custom_settings_id", "daemon_profile_id", "deleted", "revision"] }), ...cleanupAfter];
    }
    return [...settingsBefore, upsertRow(appStateTables.threadProfilePreferences, {
      ...values, harness: record.harness, thread_id: record.threadId,
    }, { conflictColumns: ["daemon_registration_id", "harness", "thread_id"], updateColumns: ["kind", "custom_settings_id", "daemon_profile_id", "deleted", "revision"] }), ...cleanupAfter];
  }

  #deleteProfile(
    identity: Extract<WorkbenchClientStateIdentity, { kind: "draftProfilePreference" | "newThreadProfilePreference" | "threadProfilePreference" }>,
    revision: number,
  ): WorkbenchDatabaseMutation[] {
    const changes = { custom_settings_id: null, daemon_profile_id: null, deleted: 1 as const, revision };
    const cleanup = deleteRows(appStateTables.composerSettings, { id: customSettingsId(identity) });
    if (identity.kind === "newThreadProfilePreference") {
      return [updateRows(appStateTables.newThreadProfilePreferences, changes, {
        daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId,
      }), cleanup];
    }
    if (identity.kind === "draftProfilePreference") {
      return [updateRows(appStateTables.draftProfilePreferences, changes, {
        daemon_registration_id: identity.daemonRegistrationId, draft_id: identity.draftId,
        harness: identity.harness, project_id: identity.projectId,
      }), cleanup];
    }
    return [updateRows(appStateTables.threadProfilePreferences, changes, {
      daemon_registration_id: identity.daemonRegistrationId, harness: identity.harness, thread_id: identity.threadId,
    }), cleanup];
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
