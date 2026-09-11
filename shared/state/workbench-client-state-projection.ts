/*
 * Exports:
 * - WorkbenchClientStateProjectionChange: one domain upsert or deletion projected from relational app-state rows.
 * - projectWorkbenchClientStateRows: project schema-conformed relational rows into browser domain changes.
 * - workbenchClientStateRecordIdentity: derive the stable identity of one projected domain record.
 */
import type {
  WorkbenchClientStateIdentity,
  WorkbenchClientStateRecord,
  WorkbenchClientStateRows,
  WorkbenchGlobalPreference,
  WorkbenchProjectPreference,
  WorkbenchSidebarPreference,
} from "./workbench-client-state.ts";

export type WorkbenchClientStateProjectionChange =
  | { change: "delete"; identity: WorkbenchClientStateIdentity; revision: number }
  | { change: "upsert"; record: WorkbenchClientStateRecord; revision: number };

function scalarValue(row: {
  boolean_value?: number | null;
  integer_value?: number | null;
  text_value?: string | null;
}) {
  if (row.boolean_value !== undefined && row.boolean_value !== null) return row.boolean_value === 1;
  if (row.integer_value !== undefined && row.integer_value !== null) return row.integer_value;
  if (row.text_value !== undefined && row.text_value !== null) return row.text_value;
  throw new Error("Live app preference row has no value.");
}

export function workbenchClientStateRecordIdentity(
  record: WorkbenchClientStateRecord,
): WorkbenchClientStateIdentity {
  switch (record.kind) {
    case "modelPreference": return { kind: record.kind, harness: record.harness, modelId: record.modelId };
    case "globalPreference": return { key: record.preference.key, kind: record.kind };
    case "projectPreference": return { daemonRegistrationId: record.daemonRegistrationId, key: record.preference.key, kind: record.kind, projectId: record.projectId };
    case "sidebarPreference": return { daemonRegistrationId: record.daemonRegistrationId, key: record.preference.key, kind: record.kind, projectId: record.projectId };
    case "sidebarFolder": return { daemonRegistrationId: record.daemonRegistrationId, folderId: record.folderId, kind: record.kind, projectId: record.projectId, scope: record.scope };
    case "expandedDirectory": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, path: record.path, projectId: record.projectId };
    case "fileDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, path: record.path, projectId: record.projectId };
    case "composerDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, projectId: record.projectId, threadId: record.threadId };
    case "questionnaireDraft": return { daemonRegistrationId: record.daemonRegistrationId, kind: record.kind, projectId: record.projectId, requestKey: record.requestKey, threadId: record.threadId };
    case "lastLaunchTarget": return { kind: record.kind };
  }
}

export function projectWorkbenchClientStateRows(
  rows: WorkbenchClientStateRows,
): WorkbenchClientStateProjectionChange[] {
  const changes: WorkbenchClientStateProjectionChange[] = [];
  const add = (
    revision: number,
    deleted: number,
    record: WorkbenchClientStateRecord,
    identity = workbenchClientStateRecordIdentity(record),
  ) => {
    changes.push(deleted
      ? { change: "delete", identity, revision }
      : { change: "upsert", record, revision });
  };
  const remove = (revision: number, identity: WorkbenchClientStateIdentity) => {
    changes.push({ change: "delete", identity, revision });
  };

  for (const row of rows.modelPreferences) {
    add(row.revision, row.deleted, {
      kind: "modelPreference", harness: row.harness, modelId: row.model_id, favourite: row.favourite === 1,
    });
  }
  for (const row of rows.globalPreferences) {
    const identity = { key: row.key, kind: "globalPreference" as const };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      kind: "globalPreference",
      preference: { key: row.key, value: scalarValue(row) } as WorkbenchGlobalPreference,
    });
  }
  for (const row of rows.projectPreferences) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      key: row.key,
      kind: "projectPreference" as const,
      projectId: row.project_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "projectPreference",
      preference: { enabled: row.enabled === 1, key: row.key, value: scalarValue(row) } as WorkbenchProjectPreference,
      projectId: row.project_id,
    });
  }
  for (const row of rows.projectSidebarPreferences) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      key: row.key,
      kind: "sidebarPreference" as const,
      projectId: row.project_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "sidebarPreference",
      preference: { key: row.key, value: scalarValue(row) } as WorkbenchSidebarPreference,
      projectId: row.project_id,
    });
  }
  for (const row of rows.projectSidebarFolders) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      folderId: row.folder_id,
      kind: "sidebarFolder" as const,
      projectId: row.project_id,
      scope: row.scope,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, identity);
  }
  for (const row of rows.projectExpandedDirectories) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "expandedDirectory" as const,
      path: row.path,
      projectId: row.project_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, identity);
  }
  for (const row of rows.lastLaunchTarget) {
    const identity = { kind: "lastLaunchTarget" as const };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "lastLaunchTarget",
      projectId: row.project_id,
    }, identity);
  }

  for (const row of rows.fileDrafts) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "fileDraft" as const,
      path: row.path,
      projectId: row.project_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      ...identity,
      value: {
        baselineContent: row.baseline_content!,
        content: row.content!,
        expectedMtimeMs: row.expected_mtime_ms,
        headContent: row.head_content,
        mode: row.mode!,
      },
    });
  }

  const composerAttachments = new Map<string, Array<{ id: string; url: string }>>();
  for (const row of rows.composerDraftAttachments) {
    const key = `${row.daemon_registration_id}\0${row.project_id}\0${row.thread_id}`;
    const values = composerAttachments.get(key) ?? [];
    values.push({ id: row.id, url: row.url });
    composerAttachments.set(key, values);
  }
  for (const row of rows.composerDrafts) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "composerDraft" as const,
      projectId: row.project_id,
      threadId: row.thread_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else add(row.revision, 0, {
      ...identity,
      value: {
        attachments: composerAttachments.get(`${row.daemon_registration_id}\0${row.project_id}\0${row.thread_id}`) ?? [],
        text: row.text!,
        updatedAt: row.updated_at!,
      },
    });
  }

  const questionnaireAnswers = new Map<string, Record<string, string>>();
  const questionnaireSelections = new Map<string, Record<string, string[]>>();
  const questionnaireAttachments = new Map<string, Array<{ id: string; url: string }>>();
  const questionnaireKey = (row: {
    daemon_registration_id: string;
    project_id: string;
    request_key: string;
    thread_id: string;
  }) => `${row.daemon_registration_id}\0${row.project_id}\0${row.thread_id}\0${row.request_key}`;
  for (const row of rows.questionnaireDraftAnswers) {
    const key = questionnaireKey(row);
    const values = questionnaireAnswers.get(key) ?? {};
    values[row.key] = row.answer;
    questionnaireAnswers.set(key, values);
  }
  for (const row of rows.questionnaireDraftSelections) {
    const key = questionnaireKey(row);
    const values = questionnaireSelections.get(key) ?? {};
    (values[row.key] ??= []).push(row.value);
    questionnaireSelections.set(key, values);
  }
  for (const row of rows.questionnaireDraftAttachments) {
    const key = questionnaireKey(row);
    const values = questionnaireAttachments.get(key) ?? [];
    values.push({ id: row.key, url: row.url });
    questionnaireAttachments.set(key, values);
  }
  for (const row of rows.questionnaireDrafts) {
    const identity = {
      daemonRegistrationId: row.daemon_registration_id,
      kind: "questionnaireDraft" as const,
      projectId: row.project_id,
      requestKey: row.request_key,
      threadId: row.thread_id,
    };
    if (row.deleted) remove(row.revision, identity);
    else {
      const key = questionnaireKey(row);
      add(row.revision, 0, {
        ...identity,
        value: {
          attachments: questionnaireAttachments.get(key) ?? [],
          customValues: questionnaireAnswers.get(key) ?? {},
          selectedValues: questionnaireSelections.get(key) ?? {},
          updatedAt: row.updated_at!,
        },
      });
    }
  }

  return changes.sort((left, right) => left.revision - right.revision);
}
