/*
 * Exports:
 * - default WorkbenchAppStateController: own app-state bootstrap, schema capability, revision reads, serialized domain
 *   mutations, and forgetting state keyed to logical projects that no longer exist.
 */
import {
  type WorkbenchProjectRemap,
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateMutation,
  type WorkbenchClientStateRecord,
  type WorkbenchClientStateResponse,
  type WorkbenchClientStateRows,
  type WorkbenchClientStateAttachmentIdentity,
  type WorkbenchGlobalPreference,
  type WorkbenchLogicalProjectPreference,
  type WorkbenchSidebarPreference,
} from "workbench-shared/state/workbench-client-state";import { workbenchClientStateAttachmentUrl } from "workbench-shared/state/workbench-client-state";
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

/** List-valued preferences (`markTags`) store no scalar; their rows own child tables instead. */
type ScalarPreference = WorkbenchGlobalPreference | WorkbenchLogicalProjectPreference | WorkbenchSidebarPreference;
const STORED_IMAGE = "workbench:stored-image";
type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
type BrowserProjection = { browserStateId: string; attachmentsAsUrls: boolean };
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

  read(sinceRevision?: number, projection?: BrowserProjection, { bindings = true } = {}): WorkbenchClientStateResponse {
    const version = this.#repository.currentVersion();
    const canUseDelta = sinceRevision !== undefined
      && sinceRevision >= version.oldestAvailableRevision
      && sinceRevision <= version.revision;
    return {
      ...(projection?.attachmentsAsUrls ? { attachmentsAsUrls: true } : {}),
      daemonRegistrationId: this.daemonRegistrationId,
      ...(bindings ? {
        registrations: this.#repository.readDaemonRegistrations(),
        projectAliases: this.#repository.readDaemonRegistrations().map(registration => ({
          daemonRegistrationId: registration.id,
          aliases: this.#repository.readProjectAliases(registration.id),
        })),
      } : {}),
      kind: canUseDelta ? "delta" : "snapshot",
      rows: this.#readRows(canUseDelta ? sinceRevision : -1, projection),
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
    // Keep scalar preference reads from expanding stored draft images.
    const rows = this.#readRows(this.#repository.currentVersion().revision);
    rows.globalPreferences = this.#repository.query(selectRows(appStateClientTables.globalPreferences, {
      where: { key }, limit: 1,
    }));
    if (key === "markTags") rows.globalMarkTags = this.#repository.query(selectRows(appStateClientTables.globalMarkTags));
    for (const change of projectWorkbenchClientStateRows(rows)) {
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

  mutate(mutation: WorkbenchClientStateMutation, projection?: BrowserProjection) {
    const operation = this.#mutationQueue.then(() => {
      const canonical = mutation.action === "put"
        ? { ...mutation, record: this.#canonicalProject(mutation.record) }
        : { ...mutation, identity: this.#canonicalProject(mutation.identity) };
      const revision = this.#repository.commit((nextRevision) => this.#buildMutation(canonical, nextRevision));
      // Record mutations never change daemon bindings; omitting them keeps each acknowledgement to the written rows.
      return this.read(revision - 1, projection, { bindings: false });
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  get revision() {
    return this.#repository.currentVersion().revision;
  }

  bindDaemons(
    sources: readonly { daemonId: string; attachedLocal: boolean }[],
    projection?: BrowserProjection,
  ) {
    const operation = this.#mutationQueue.then(() => {
      for (const source of sources) this.#repository.registerDaemon(source.daemonId, source.attachedLocal);
      return this.read(undefined, projection);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  readAttachment(identity: WorkbenchClientStateAttachmentIdentity, attachmentId: string) {
    return this.#readImage(this.#canonicalProject(identity), attachmentId);
  }

  putAttachment(
    identity: WorkbenchClientStateAttachmentIdentity,
    attachmentId: string,
    mediaType: ImageMediaType,
    content: Uint8Array,
    projection?: BrowserProjection,
  ) {
    const operation = this.#mutationQueue.then(() => {
      const owner = this.#canonicalProject(identity);
      const composer = owner.kind === "composerDraft";
      const ownerWhere = {
        daemon_registration_id: owner.daemonRegistrationId,
        project_id: owner.projectId,
        thread_id: owner.threadId,
        ...(!composer ? { request_key: owner.requestKey } : {}),
      };
      const parent = this.#repository.query(selectRows(
        composer ? appStateTables.composerDrafts : appStateTables.questionnaireDrafts,
        { where: ownerWhere, limit: 1 },
      ))[0];
      if (!parent || parent.deleted) throw new Error("The image draft is unavailable.");
      const attachments = this.#repository.query(selectRows(
        composer ? appStateTables.composerDraftAttachments : appStateTables.questionnaireDraftAttachments,
        { where: ownerWhere },
      ));
      const position = Math.max(-1, ...attachments.map(row => row.position)) + 1;
      const revision = this.#repository.commit(nextRevision => composer
        ? [
          upsertRow(appStateTables.composerDraftAttachments, {
            ...ownerWhere, id: attachmentId, owner_deleted: 0, url: STORED_IMAGE, position,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "id"],
            updateColumns: ["url"] }),
          upsertRow(appStateTables.composerDraftImageContent, {
            ...ownerWhere, attachment_id: attachmentId, media_type: mediaType, content,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "attachment_id"],
            updateColumns: ["media_type", "content"] }),
          updateRows(appStateTables.composerDrafts, { revision: nextRevision }, ownerWhere),
        ]
        : [
          upsertRow(appStateTables.questionnaireDraftAttachments, {
            ...ownerWhere, request_key: "requestKey" in owner ? owner.requestKey : "",
            key: attachmentId, owner_deleted: 0, url: STORED_IMAGE, position,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "request_key", "key"],
            updateColumns: ["url"] }),
          upsertRow(appStateTables.questionnaireDraftImageContent, {
            ...ownerWhere, request_key: "requestKey" in owner ? owner.requestKey : "",
            attachment_id: attachmentId, media_type: mediaType, content,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "request_key", "attachment_id"],
            updateColumns: ["media_type", "content"] }),
          updateRows(appStateTables.questionnaireDrafts, { revision: nextRevision }, ownerWhere),
        ]);
      return this.read(revision - 1, projection);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #readImage(identity: WorkbenchClientStateAttachmentIdentity, attachmentId: string) {
    const composer = identity.kind === "composerDraft";
    const ownerWhere = {
      daemon_registration_id: identity.daemonRegistrationId,
      project_id: identity.projectId,
      thread_id: identity.threadId,
      ...(!composer ? { request_key: identity.requestKey } : {}),
    };
    const attachment = this.#repository.query(selectRows(
      composer ? appStateTables.composerDraftAttachments : appStateTables.questionnaireDraftAttachments,
      { where: { ...ownerWhere, ...(composer ? { id: attachmentId } : { key: attachmentId }) }, limit: 1 },
    ))[0];
    if (!attachment) return null;
    if (attachment.url === STORED_IMAGE) {
      const row = this.#repository.query(selectRows(
        composer ? appStateTables.composerDraftImageContent : appStateTables.questionnaireDraftImageContent,
        { where: { ...ownerWhere, attachment_id: attachmentId }, limit: 1 },
      ))[0];
      if (!row) throw new Error("Saved draft image content is missing.");
      return { content: row.content, mediaType: row.media_type };
    }
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(attachment.url);
    return match ? {
      content: Buffer.from(match[2]!, "base64"),
      mediaType: match[1]! as ImageMediaType,
    } : null;
  }

  readProjectAliases() {
    return this.#repository.readProjectAliases();
  }

  registerDaemon(daemonId: string, attachedLocal: boolean) {
    const operation = this.#mutationQueue.then(() => {
      const registrationId = this.#repository.registerDaemon(daemonId, attachedLocal);
      return { registrationId, state: this.read() };
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  remapProjects(request: WorkbenchProjectRemap) {
    const operation = this.#mutationQueue.then(() => {
      const revision = this.#repository.remapProjects(request, (aliases, revision) => {
        const mapping = new Map(aliases.map(alias => [alias.alias, alias.projectId]));
        // The repository carries tombstones separately. They must not compete
        // with live records when several old addresses converge on one owner.
        const changes = projectWorkbenchClientStateRows(this.read().rows).filter(change => change.change === "upsert");
        const identities = changes.map(change => recordIdentity(change.record));
        const moved: WorkbenchClientStateIdentity[] = [];
        const mutations: WorkbenchDatabaseMutation[] = [];
        for (const change of changes) {
          if (change.record.kind === "lastLaunchTarget") {
            const projectId = mapping.get(change.record.projectId);
            if (projectId && change.record.daemonRegistrationId === request.daemonRegistrationId) {
              mutations.push(...this.#put({ ...change.record, projectId }, revision));
            }
            continue;
          }
          const value = change.record;
          if (!("projectId" in value) || value.daemonRegistrationId !== request.daemonRegistrationId) continue;
          const projectId = mapping.get(value.projectId);
          if (!projectId) continue;
          const next = { ...value, projectId };
          const identity = recordIdentity(next as WorkbenchClientStateRecord);
          if (identities.some(existing => isDeepStrictEqual(existing, identity)) || moved.some(existing => isDeepStrictEqual(existing, identity))) {
            throw new Error("Project remap conflicts with existing saved state.");
          }
          moved.push(identity);
          mutations.push(...this.#put({ ...change.record, projectId } as WorkbenchClientStateRecord, revision));
          if (value.kind === "composerDraft") {
            const images = this.#repository.query(selectRows(appStateTables.composerDraftImageContent, {
              where: {
                daemon_registration_id: value.daemonRegistrationId,
                project_id: value.projectId,
                thread_id: value.threadId,
              },
            }));
            for (const image of images) {
              const where = {
                daemon_registration_id: image.daemon_registration_id,
                project_id: projectId,
                thread_id: image.thread_id,
              };
              mutations.push(updateRows(appStateTables.composerDraftAttachments, { url: STORED_IMAGE }, {
                ...where, id: image.attachment_id,
              }));
              mutations.push(insertRow(appStateTables.composerDraftImageContent, {
                ...where, attachment_id: image.attachment_id,
                media_type: image.media_type, content: image.content,
              }));
            }
          }
          if (value.kind === "questionnaireDraft") {
            const images = this.#repository.query(selectRows(appStateTables.questionnaireDraftImageContent, {
              where: {
                daemon_registration_id: value.daemonRegistrationId,
                project_id: value.projectId,
                thread_id: value.threadId,
                request_key: value.requestKey,
              },
            }));
            for (const image of images) {
              const where = {
                daemon_registration_id: image.daemon_registration_id,
                project_id: projectId,
                thread_id: image.thread_id,
                request_key: image.request_key,
              };
              mutations.push(updateRows(appStateTables.questionnaireDraftAttachments, { url: STORED_IMAGE }, {
                ...where, key: image.attachment_id,
              }));
              mutations.push(insertRow(appStateTables.questionnaireDraftImageContent, {
                ...where, attachment_id: image.attachment_id,
                media_type: image.media_type, content: image.content,
              }));
            }
          }
          mutations.push(...this.#delete(recordIdentity(change.record), revision));
        }
        return mutations;
      });
      return this.read(revision - 1);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Logical project ids are never reused, so state for one outside `live` is unreachable: delete its preferences and
   * drop it from the saved selection. Resolves to the current revision; unchanged state commits nothing.
   */
  forgetLogicalProjects(live: ReadonlySet<string>) {
    const operation = this.#mutationQueue.then(() => {
      // Read only the logically keyed families; a full read would expand stored draft images.
      const rows = this.#readRows(this.#repository.currentVersion().revision);
      rows.logicalProjectPreferences = this.#repository.query(selectRows(appStateClientTables.logicalProjectPreferences, {}));      rows.lastProjectSelections = this.#repository.query(selectRows(appStateClientTables.lastProjectSelections, {}));
      rows.lastProjectSelectionProjects = this.#repository.query(selectRows(appStateClientTables.lastProjectSelectionProjects, {}));
      type ProjectKeyed = Extract<WorkbenchClientStateRecord, { kind: "logicalProjectPreference" | "lastProjectSelection" }>;
      const stale = projectWorkbenchClientStateRows(rows).flatMap((change): ProjectKeyed[] => {
        if (change.change !== "upsert") return [];
        const { record } = change;
        if (record.kind === "logicalProjectPreference") return live.has(record.logicalProjectId) ? [] : [record];
        return record.kind === "lastProjectSelection" && record.selectedProjectIds?.some(id => !live.has(id)) ? [record] : [];
      });
      if (!stale.length) return this.revision;
      return this.#repository.commit(revision => stale.flatMap(record => record.kind === "lastProjectSelection"
        ? this.#put({ ...record, selectedProjectIds: record.selectedProjectIds?.filter(id => live.has(id)) ?? null }, revision)
        : this.#delete(recordIdentity(record), revision)));
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #canonicalProject<Value extends WorkbenchClientStateRecord | WorkbenchClientStateIdentity>(value: Value): Value {
    if (!("projectId" in value)) return value;
    return { ...value, projectId: this.#repository.resolveProjectId(value.daemonRegistrationId, value.projectId) };
  }

  #readRows(sinceRevision: number, projection?: BrowserProjection): WorkbenchClientStateRows {
    const changed = <Row extends { revision: number }>(rows: Row[]) => (
      rows.filter((row) => row.revision > sinceRevision)
    );
    const composerDrafts = changed(this.#repository.query(selectRows(appStateClientTables.composerDrafts)));
    const fileDrafts = changed(this.#repository.query(selectRows(appStateClientTables.fileDrafts)));
    // Like other draft children, history rides along only for drafts that changed.
    const fileDraftOwners = fileDrafts.filter(draft => !draft.deleted).map(draft => ({
      where: { daemon_registration_id: draft.daemon_registration_id, project_id: draft.project_id, path: draft.path },
    }));
    const lastProjectSelections = changed(
      this.#repository.query(selectRows(appStateClientTables.lastProjectSelections)),
    );
    const questionnaireDrafts = changed(this.#repository.query(selectRows(appStateClientTables.questionnaireDrafts)));
    // Mark tags carry no revision either; a put rewrites them and bumps their preference, so they ride along with it.
    const globalPreferences = changed(this.#repository.query(selectRows(appStateClientTables.globalPreferences)));
    const logicalProjectPreferences = changed(this.#repository.query(selectRows(appStateClientTables.logicalProjectPreferences)));
    // Children carry no revision; a put rewrites them and bumps their draft, so only changed drafts' children ride along.
    type QuestionnaireOwner = { daemon_registration_id: string; project_id: string; thread_id: string; request_key: string };
    const ownerKey = (row: QuestionnaireOwner) => `${row.daemon_registration_id}\0${row.project_id}\0${row.thread_id}\0${row.request_key}`;
    const changedQuestionnaires = new Set(questionnaireDrafts.map(ownerKey));
    const questionnaireChildren = <Row extends QuestionnaireOwner>(rows: Row[]) => rows.filter(row => changedQuestionnaires.has(ownerKey(row)));
    const imageUrl = (identity: WorkbenchClientStateAttachmentIdentity, id: string, stored: string) => {
      if (projection?.attachmentsAsUrls
        && (stored === STORED_IMAGE || /^data:image\/(?:png|jpeg|webp|gif);base64,/u.test(stored))) {
        return workbenchClientStateAttachmentUrl(projection.browserStateId, identity, id);
      }
      if (stored !== STORED_IMAGE) return stored;
      const image = this.#readImage(identity, id);
      if (!image) throw new Error("Saved draft image content is missing.");
      return `data:${image.mediaType};base64,${Buffer.from(image.content).toString("base64")}`;
    };
    return {
      composerDraftAttachments: composerDrafts.flatMap(draft => this.#repository.query(selectRows(
        appStateClientTables.composerDraftAttachments, {
          where: {
            daemon_registration_id: draft.daemon_registration_id,
            project_id: draft.project_id,
            thread_id: draft.thread_id,
          },
        }))).map(row => ({
          ...row, url: imageUrl({
            kind: "composerDraft", daemonRegistrationId: row.daemon_registration_id,
            projectId: row.project_id, threadId: row.thread_id,
          }, row.id, row.url),
        })),
      composerDraftReferences: composerDrafts.flatMap(draft => this.#repository.query(selectRows(
        appStateClientTables.composerDraftReferences, {
          where: {
            daemon_registration_id: draft.daemon_registration_id,
            project_id: draft.project_id,
            thread_id: draft.thread_id,
          },
        }))),
      composerDrafts,
      fileDraftHistories: fileDraftOwners.flatMap(owner => this.#repository.query(selectRows(
        appStateClientTables.fileDraftHistories, owner))),
      fileDraftHistoryFrames: fileDraftOwners.flatMap(owner => this.#repository.query(selectRows(
        appStateClientTables.fileDraftHistoryFrames, owner))),
      fileDrafts,
      globalMarkTags: globalPreferences.some(row => row.key === "markTags" && !row.deleted)
        ? this.#repository.query(selectRows(appStateClientTables.globalMarkTags))
        : [],
      globalPreferences,
      modelPreferences: changed(this.#repository.query(selectRows(appStateClientTables.modelPreferences))),
      modelGroupDisclosures: changed(this.#repository.query(selectRows(appStateClientTables.modelGroupDisclosures))),
      lastLaunchTarget: changed(this.#repository.query(selectRows(appStateClientTables.lastLaunchTarget))),
      lastProjectSelectionProjects: lastProjectSelections.length
        ? this.#repository.query(selectRows(appStateClientTables.lastProjectSelectionProjects))
        : [],
      lastProjectSelections,
      logicalProjectMarkTags: logicalProjectPreferences.filter(row => row.key === "markTags" && !row.deleted)
        .flatMap(row => this.#repository.query(selectRows(appStateClientTables.logicalProjectMarkTags, {
          where: { logical_project_id: row.logical_project_id },
        }))),
      logicalProjectPreferences,
      projectExpandedDirectories: changed(this.#repository.query(selectRows(appStateClientTables.projectExpandedDirectories))),
      projectPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectPreferences))),
      projectSidebarFolders: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarFolders))),
      projectSidebarPreferences: changed(this.#repository.query(selectRows(appStateClientTables.projectSidebarPreferences))),
      questionnaireDraftAnswers: questionnaireChildren(this.#repository.query(selectRows(appStateClientTables.questionnaireDraftAnswers))),
      // Attachments can hold inline image data, so they are read per changed draft rather than filtered from every row.
      questionnaireDraftAttachments: questionnaireDrafts.flatMap(draft => this.#repository.query(selectRows(
        appStateClientTables.questionnaireDraftAttachments, {
          where: {
            daemon_registration_id: draft.daemon_registration_id,
            project_id: draft.project_id,
            thread_id: draft.thread_id,
            request_key: draft.request_key,
          },
        }))).map(row => ({
          ...row, url: imageUrl({
            kind: "questionnaireDraft", daemonRegistrationId: row.daemon_registration_id,
            projectId: row.project_id, threadId: row.thread_id, requestKey: row.request_key,
          }, row.key, row.url),
        })),
      questionnaireDraftSelections: questionnaireChildren(this.#repository.query(selectRows(appStateClientTables.questionnaireDraftSelections))),
      questionnaireDrafts,
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
      case "modelGroupDisclosure":
        return [upsertRow(appStateTables.modelGroupDisclosures, {
          group_id: record.groupId, open: Number(record.open) as 0 | 1, deleted: 0, revision,
        }, { conflictColumns: ["group_id"], updateColumns: ["open", "deleted", "revision"] })];
      case "globalPreference": {
        const tags = record.preference.key === "markTags" ? record.preference.value : null;
        return [
          ...(tags ? [deleteRows(appStateTables.globalMarkTags, { owner_key: "markTags" })] : []),
          upsertRow(appStateTables.globalPreferences, {
            ...scalarColumns(record.preference),
            deleted: 0,
            key: record.preference.key,
            revision,
          }, { conflictColumns: ["key"], updateColumns: ["boolean_value", "integer_value", "text_value", "deleted", "revision"] }),
          ...(tags ?? []).map((tag, position) => insertRow(appStateTables.globalMarkTags, {
            color: tag.color, name: tag.name, owner_deleted: 0, owner_key: "markTags", position,
          })),
        ];
      }
      case "logicalProjectPreference": {
        const tags = record.preference.key === "markTags" ? record.preference.value : null;
        return [
          ...(tags ? this.#deleteLogicalProjectMarkTags(record.logicalProjectId) : []),
          upsertRow(appStateTables.logicalProjectPreferences, {
            ...scalarColumns(record.preference),
            deleted: 0,
            enabled: Number(record.preference.enabled) as 0 | 1,
            key: record.preference.key,
            logical_project_id: record.logicalProjectId,
            revision,
          }, { conflictColumns: ["logical_project_id", "key"],
            updateColumns: ["enabled", "boolean_value", "integer_value", "text_value", "deleted", "revision"] }),
          ...(tags ?? []).map((tag, position) => insertRow(appStateTables.logicalProjectMarkTags, {
            color: tag.color, logical_project_id: record.logicalProjectId, name: tag.name,
            owner_deleted: 0, owner_key: "markTags", position,
          })),
        ];
      }
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
      case "lastProjectSelection":
        return [
          deleteRows(appStateTables.lastProjectSelectionProjects, { owner_id: "singleton" }),
          upsertRow(appStateTables.lastProjectSelections, {
            deleted: 0,
            id: "singleton",
            mode: record.selectedProjectIds === null ? "unfiltered" : "explicit",
            revision,
          }, { conflictColumns: ["id"], updateColumns: ["mode", "deleted", "revision"] }),
          ...(record.selectedProjectIds ?? []).map((logicalProjectId, position) =>
            insertRow(appStateTables.lastProjectSelectionProjects, {
              logical_project_id: logicalProjectId,
              owner_deleted: 0,
              owner_id: "singleton",
              owner_mode: "explicit",
              position,
            })),
        ];
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
        }, { conflictColumns: ["daemon_registration_id", "project_id", "path"], updateColumns: ["baseline_content", "content", "expected_mtime_ms", "head_content", "mode", "deleted", "revision"] }),
        ...this.#replaceFileDraftHistory(record)];
      case "composerDraft": {
        return [
          upsertRow(appStateTables.composerDrafts, {
            daemon_registration_id: record.daemonRegistrationId,
            deleted: 0,
            project_id: record.projectId,
            revision,
            text: record.value.text,
            thread_id: record.threadId,
            updated_at: record.value.updatedAt,
          }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id"], updateColumns: ["text", "updated_at", "deleted", "revision"] }),
          ...this.#replaceComposerReferences(record),
          ...this.#replaceComposerAttachments(record),
        ];
      }
      case "questionnaireDraft":
        return [
          ...this.#deleteQuestionnaireChildren(record, false),
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
          ...this.#replaceQuestionnaireAttachments(record),
        ];
    }
  }

  #delete(identity: WorkbenchClientStateIdentity, revision: number): WorkbenchDatabaseMutation[] {
    switch (identity.kind) {
      case "modelPreference":
        return [updateRows(appStateTables.modelPreferences, { deleted: 1, revision }, {
          harness: identity.harness, model_id: identity.modelId,
        })];
      case "modelGroupDisclosure":
        return [updateRows(appStateTables.modelGroupDisclosures, { deleted: 1, revision }, {
          group_id: identity.groupId,
        })];
      case "globalPreference":
        return [
          ...(identity.key === "markTags" ? [deleteRows(appStateTables.globalMarkTags, { owner_key: "markTags" })] : []),
          updateRows(appStateTables.globalPreferences, {
            boolean_value: null, deleted: 1, integer_value: null, revision, text_value: null,
          }, { key: identity.key }),
        ];
      case "logicalProjectPreference":
        return [
          ...(identity.key === "markTags" ? this.#deleteLogicalProjectMarkTags(identity.logicalProjectId) : []),
          updateRows(appStateTables.logicalProjectPreferences, {
            boolean_value: null, deleted: 1, enabled: null, integer_value: null, revision, text_value: null,
          }, { key: identity.key, logical_project_id: identity.logicalProjectId }),
        ];
      case "lastLaunchTarget":
        return [updateRows(appStateTables.lastLaunchTarget, { deleted: 1, project_id: "", revision }, { id: "singleton" })];
      case "lastProjectSelection":
        return [
          deleteRows(appStateTables.lastProjectSelectionProjects, { owner_id: "singleton" }),
          updateRows(appStateTables.lastProjectSelections, {
            deleted: 1, mode: null, revision,
          }, { id: "singleton" }),
        ];
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
        return [...this.#deleteFileDraftHistory(identity), updateRows(appStateTables.fileDrafts, {
          baseline_content: null, content: null, deleted: 1, expected_mtime_ms: null,
          head_content: null, mode: null, revision,
        }, { daemon_registration_id: identity.daemonRegistrationId, path: identity.path, project_id: identity.projectId })];
      case "composerDraft":
        return [
          deleteRows(appStateTables.composerDraftAttachments, {
            daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId, thread_id: identity.threadId,
          }),
          deleteRows(appStateTables.composerDraftReferences, {
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

  #deleteLogicalProjectMarkTags(logicalProjectId: string): WorkbenchDatabaseMutation[] {
    return [deleteRows(appStateTables.logicalProjectMarkTags, { logical_project_id: logicalProjectId, owner_key: "markTags" })];
  }

  #deleteQuestionnaireChildren(identity: Extract<
    WorkbenchClientStateIdentity | WorkbenchClientStateRecord,
    { kind: "questionnaireDraft" }
  >, includeAttachments = true): WorkbenchDatabaseMutation[] {
    const where = {
      daemon_registration_id: identity.daemonRegistrationId,
      project_id: identity.projectId,
      request_key: identity.requestKey,
      thread_id: identity.threadId,
    };
    return [
      deleteRows(appStateTables.questionnaireDraftAnswers, where),
      deleteRows(appStateTables.questionnaireDraftSelections, where),
      ...(includeAttachments ? [deleteRows(appStateTables.questionnaireDraftAttachments, where)] : []),
    ];
  }

  #replaceComposerAttachments(record: Extract<WorkbenchClientStateRecord, { kind: "composerDraft" }>) {
    const where = {
      daemon_registration_id: record.daemonRegistrationId,
      project_id: record.projectId,
      thread_id: record.threadId,
    };
    const existing = this.#repository.query(selectRows(appStateTables.composerDraftAttachments, { where }));
    const next = new Map(record.value.attachments.map(item => [item.id, item.url]));
    const mutations: WorkbenchDatabaseMutation[] = [];
    for (const row of existing) {
      if (next.has(row.id)) continue;
      mutations.push(deleteRows(appStateTables.composerDraftAttachments, { ...where, id: row.id }));
    }
    for (const [position, [id, url]] of [...next].entries()) {
      const current = existing.find(row => row.id === id);
      if (current && current.position !== position) {
        mutations.push(updateRows(appStateTables.composerDraftAttachments, { position }, { ...where, id }));
      }
      if (url.startsWith("/api/workbench-client-state/attachment?")) {
        if (!current) throw new Error("The saved draft image reference is unavailable.");
        continue;
      }
      if (current?.url === url) continue;
      if (current?.url === STORED_IMAGE) {
        mutations.push(deleteRows(appStateTables.composerDraftImageContent, { ...where, attachment_id: id }));
      }
      mutations.push(upsertRow(appStateTables.composerDraftAttachments, {
        ...where, id, owner_deleted: 0, url, position,
      }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "id"],
        updateColumns: ["url", "position"] }));
    }
    return mutations;
  }

  #deleteFileDraftHistory(identity: Extract<WorkbenchClientStateIdentity | WorkbenchClientStateRecord, { kind: "fileDraft" }>) {
    const owner = { daemon_registration_id: identity.daemonRegistrationId, project_id: identity.projectId, path: identity.path };
    return [deleteRows(appStateTables.fileDraftHistoryFrames, owner), deleteRows(appStateTables.fileDraftHistories, owner)];
  }

  /** History only ever describes the content saved beside it, so every put replaces it, and one without history drops it. */
  #replaceFileDraftHistory(record: Extract<WorkbenchClientStateRecord, { kind: "fileDraft" }>) {
    const history = record.value.history;
    if (!history) return this.#deleteFileDraftHistory(record);
    const owner = { daemon_registration_id: record.daemonRegistrationId, project_id: record.projectId, path: record.path };
    return [
      ...this.#deleteFileDraftHistory(record),
      insertRow(appStateTables.fileDraftHistories, { ...owner, current_index: history.currentIndex }),
      ...history.frames.map((frame, position) => insertRow(appStateTables.fileDraftHistoryFrames, frame.kind === "snapshot"
        ? { ...owner, position, kind: "snapshot", content: frame.content, patch_start: null,
          deleted_text: null, inserted_text: null, timestamp: Math.round(frame.timestamp) }
        : { ...owner, position, kind: "patch", content: null, patch_start: frame.start,
          deleted_text: frame.deletedText, inserted_text: frame.insertedText, timestamp: Math.round(frame.timestamp) })),
    ];
  }

  #replaceComposerReferences(record: Extract<WorkbenchClientStateRecord, { kind: "composerDraft" }>) {
    if (record.value.references == null) return [];
    const owner = {
      daemon_registration_id: record.daemonRegistrationId,
      project_id: record.projectId,
      thread_id: record.threadId,
    };
    return [
      deleteRows(appStateTables.composerDraftReferences, owner),
      ...record.value.references.map((reference, position) => insertRow(appStateTables.composerDraftReferences, {
        ...owner,
        owner_deleted: 0,
        position,
        kind: reference.kind,
        body: reference.kind === "feedback" ? reference.report : reference.text,
        feedback_id: reference.kind === "feedback" ? reference.id : null,
        feedback_daemon_id: reference.kind === "feedback" ? reference.daemonId : null,
        feedback_category: reference.kind === "feedback" ? reference.category : null,
        feedback_title: reference.kind === "feedback" ? reference.title : null,
        feedback_author: reference.kind === "feedback" ? reference.author : null,
        feedback_thread: reference.kind === "feedback" ? reference.thread : null,
        feedback_created_at: reference.kind === "feedback" ? reference.createdAt : null,
      })),
    ];
  }

  #replaceQuestionnaireAttachments(record: Extract<WorkbenchClientStateRecord, { kind: "questionnaireDraft" }>) {
    const where = {
      daemon_registration_id: record.daemonRegistrationId,
      project_id: record.projectId,
      thread_id: record.threadId,
      request_key: record.requestKey,
    };
    const existing = this.#repository.query(selectRows(appStateTables.questionnaireDraftAttachments, { where }));
    const next = new Map(record.value.attachments.map(item => [item.id, item.url]));
    const mutations: WorkbenchDatabaseMutation[] = [];
    for (const row of existing) {
      if (next.has(row.key)) continue;
      mutations.push(deleteRows(appStateTables.questionnaireDraftAttachments, { ...where, key: row.key }));
    }
    for (const [position, [key, url]] of [...next].entries()) {
      const current = existing.find(row => row.key === key);
      if (current && current.position !== position) {
        mutations.push(updateRows(appStateTables.questionnaireDraftAttachments, { position }, { ...where, key }));
      }
      if (url.startsWith("/api/workbench-client-state/attachment?")) {
        if (!current) throw new Error("The saved draft image reference is unavailable.");
        continue;
      }
      if (current?.url === url) continue;
      if (current?.url === STORED_IMAGE) {
        mutations.push(deleteRows(appStateTables.questionnaireDraftImageContent, { ...where, attachment_id: key }));
      }
      mutations.push(upsertRow(appStateTables.questionnaireDraftAttachments, {
        ...where, key, owner_deleted: 0, url, position,
      }, { conflictColumns: ["daemon_registration_id", "project_id", "thread_id", "request_key", "key"],
        updateColumns: ["url", "position"] }));
    }
    return mutations;
  }
}
