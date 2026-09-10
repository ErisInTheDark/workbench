/*
 * Exports:
 * - ProjectDocument: parsed project state.
 * - SourceProject: project state with source identity and update time.
 * - asRecord: narrow external object input.
 * - parseProjectDocument: repair current and legacy project documents.
 * - parseProjectImport: reject facts that repair would discard before retiring the source.
 * - decodeGlobalDocument: decode a global state document.
 * - createSourceDigest: fingerprint source documents and relationship state.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { WorkbenchStoredSubagent } from "../../workbench-subagent-record.ts";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchComposerSettingsSchema,
  WorkbenchThreadDraftAttachmentSchema,
  WorkbenchThreadDraftSchema,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchThreadDraft,
} from "workbench-shared/workbench/thread/thread-state";
import {
  normalizeThreadDisplayLayout,
  type ThreadDisplayLayout,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  conformStoredWorkbenchThreadStateRecord,
  type WorkbenchThreadStateRecord,
} from "../../workbench-thread-state-record.ts";

interface StoredDraft extends WorkbenchThreadDraft {
  pinned: boolean;
  snoozed: boolean;
}

export interface ProjectDocument {
  displayOrder: ThreadDisplayLayout;
  drafts: StoredDraft[];
  newThreadProfile: WorkbenchComposerProfileSelectionState | null;
  records: WorkbenchThreadStateRecord[];
}

export interface SourceProject {
  document: ProjectDocument;
  projectId: string;
  updatedAt: number;
}

const StoredDraftIdentitySchema = z.object({
  draftId: z.uuid(),
  harness: z.enum(["codex", "copilot", "opencode"]),
}).passthrough();

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decodeJson(encoded: string, identity: string): unknown {
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`Stored ${identity} contains invalid JSON.`);
  }
}

function parseDraft(value: unknown, projectId: string): StoredDraft {
  const record = asRecord(value);
  const settings = WorkbenchComposerSettingsSchema.safeParse(record.composerSettings);
  const identity = StoredDraftIdentitySchema.safeParse({
    ...record,
    harness: settings.success ? settings.data.harness : record.harness,
  });
  if (!identity.success) {
    throw new Error(`Stored project ${projectId} contains a draft without a recoverable identity.`);
  }
  if (record.attachments !== undefined && !z.array(WorkbenchThreadDraftAttachmentSchema).safeParse(record.attachments).success) {
    throw new Error(`Stored project ${projectId} contains unsupported draft attachments.`);
  }
  const harness = identity.data.harness;
  const composerSettings = settings.success
    ? settings.data
    : {
      agentPath: typeof record.agent === "string" ? record.agent : null,
      agentSource: null,
      harness,
      model: typeof record.model === "string" ? record.model : "",
      reasoningEffort: typeof record.reasoningEffort === "string" ? record.reasoningEffort : null,
      serviceTier: record.serviceTier === "fast" ? "fast" as const : null,
    };
  const parsed = conformToZodSchema(WorkbenchThreadDraftSchema, { ...record, projectId }, {
    attachments: [],
    clientUpdatedAt: 0,
    composerSettings,
    createdAt: 0,
    draftId: identity.data.draftId,
    profileId: null,
    projectId,
    prompt: "",
    updatedAt: 0,
  });
  return {
    ...parsed.data,
    pinned: record.pinned === true,
    snoozed: record.snoozed === true,
  };
}

function legacyRecord(value: unknown, projectId: string) {
  const record = asRecord(value);
  return conformStoredWorkbenchThreadStateRecord({
    activityAt: record.orderAt,
    entryKind: "thread",
    identity: { harness: record.harness, threadId: record.threadId },
    lifecycle: record.lifecycle,
    mcpGeneration: record.mcpGeneration,
    metadata: { archived: record.archived, pinned: record.pinned, snoozed: record.snoozed },
    orderAt: record.orderAt,
    pendingQuestionnaire: record.pendingQuestionnaire,
    providerObserved: false,
    questionnaireHistory: record.questionnaireHistory,
    title: record.titleFallback,
  }, projectId);
}

export function parseProjectDocument(encoded: string, projectId: string): ProjectDocument {
  const source = asRecord(decodeJson(encoded, `thread-state project ${projectId}`));
  const candidates = Array.isArray(source.records)
    ? source.records
    : Array.isArray(source.threads) ? source.threads : [];
  const records = candidates.map((candidate) => {
    const parsed = Array.isArray(source.records)
      ? conformStoredWorkbenchThreadStateRecord(candidate, projectId)
      : legacyRecord(candidate, projectId);
    if (!parsed.success) throw new Error(`Stored project ${projectId} contains a provider record without a recoverable identity.`);
    return parsed.data;
  });
  const drafts = Array.isArray(source.drafts) ? source.drafts.map((draft) => parseDraft(draft, projectId)) : [];
  const profile = WorkbenchComposerProfileSelectionSchema.safeParse(source.newThreadProfile);
  const latestDraft = drafts.slice().sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const latestProfile = latestDraft
    ? latestDraft.profileId
      ? { kind: "profile" as const, profileId: latestDraft.profileId, settings: latestDraft.composerSettings }
      : { kind: "custom" as const, settings: latestDraft.composerSettings }
    : null;
  return {
    displayOrder: normalizeThreadDisplayLayout(source.displayOrder),
    drafts,
    newThreadProfile: profile.success ? profile.data : latestProfile,
    records,
  };
}

export function parseProjectImport(encoded: string, projectId: string): ProjectDocument {
  const decoded = decodeJson(encoded, "thread-state import");
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Thread-state import has no project object.");
  const source = asRecord(decoded);
  const parsed = parseProjectDocument(encoded, projectId);
  const supported = new Set(["version", "records", "threads", "drafts", "displayOrder", "newThreadProfile"]);
  if (Object.keys(source).some(key => !supported.has(key))
    || source.version !== undefined && ![1, 2, 3, 4].includes(Number(source.version))
    || source.records !== undefined && !Array.isArray(source.records)
    || source.threads !== undefined && !Array.isArray(source.threads)
    || source.drafts !== undefined && !Array.isArray(source.drafts)
    || source.records !== undefined && source.threads !== undefined) {
    throw new Error("Thread-state import contains unsupported project facts.");
  }
  const preserve = (value: unknown, actual: unknown, location: string): void => {
    if (Array.isArray(value)) {
      if (!Array.isArray(actual) || value.length !== actual.length) throw new Error(`Thread-state import would discard ${location}.`);
      value.forEach((item, index) => preserve(item, actual[index], location));
    } else if (value && typeof value === "object") {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`Thread-state import would discard ${location}.`);
      const candidate = asRecord(actual);
      for (const [key, field] of Object.entries(value)) preserve(field, candidate[key], location);
    } else if (!isDeepStrictEqual(value, actual)) {
      throw new Error(`Thread-state import would change ${location}.`);
    }
  };
  if (Array.isArray(source.records)) source.records.forEach((record, index) => preserve(record, parsed.records[index], "thread facts"));
  if (Array.isArray(source.threads)) {
    const legacyFields = new Set([
      "archived", "harness", "lifecycle", "mcpGeneration", "orderAt", "pendingQuestionnaire",
      "pinned", "questionnaireHistory", "snoozed", "threadId", "titleFallback",
    ]);
    source.threads.forEach((value, index) => {
      const record = asRecord(value);
      if (Object.keys(record).some(key => !legacyFields.has(key))) throw new Error("Thread-state import contains unsupported legacy thread facts.");
      const actual = parsed.records[index]!;
      if (actual.entryKind !== "thread") throw new Error("Legacy thread changed its kind during import.");
      preserve(record, {
        ...actual.metadata, harness: actual.identity.harness, threadId: actual.identity.threadId,
        lifecycle: actual.lifecycle, mcpGeneration: actual.mcpGeneration, orderAt: actual.orderAt,
        pendingQuestionnaire: actual.pendingQuestionnaire, questionnaireHistory: actual.questionnaireHistory,
        titleFallback: actual.title,
      }, "legacy thread facts");
    });
  }
  if (Array.isArray(source.drafts)) {
    source.drafts.forEach((value, index) => {
      const { agent, harness, model, reasoningEffort, serviceTier, composerSettings, ...facts } = asRecord(value);
      const settings = WorkbenchComposerSettingsSchema.safeParse(composerSettings);
      preserve({
        ...facts,
        composerSettings: settings.success ? settings.data : {
          agentPath: typeof agent === "string" ? agent : null,
          agentSource: null, harness,
          model: typeof model === "string" ? model : "",
          reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : null,
          serviceTier: serviceTier === "fast" ? "fast" : null,
        },
      }, parsed.drafts[index], "draft facts");
    });
  }
  if (source.displayOrder !== undefined) preserve(source.displayOrder, parsed.displayOrder, "layout facts");
  if (source.newThreadProfile != null) preserve(source.newThreadProfile, parsed.newThreadProfile, "profile facts");
  return parsed;
}

export function decodeGlobalDocument(encoded: string, id: string) {
  return asRecord(decodeJson(encoded, `thread-state global ${id}`));
}

export function createSourceDigest(
  projects: ReadonlyArray<{ documentJson: string; projectId: string; updatedAt: number }>,
  globals: ReadonlyArray<{ documentJson: string; id: string }>,
  relationships: readonly WorkbenchStoredSubagent[],
) {
  const relationshipRows = [...relationships].sort((left, right) => (
    `${left.projectId}\0${left.harness}\0${left.kind === "reserved" ? left.reservationId : left.threadId}`
      .localeCompare(`${right.projectId}\0${right.harness}\0${right.kind === "reserved" ? right.reservationId : right.threadId}`)
  )).map((relationship) => ({
    createdAt: relationship.createdAt,
    cwd: relationship.cwd,
    directSubagentIndex: relationship.directSubagentIndex,
    harness: relationship.harness,
    kind: relationship.kind,
    name: relationship.name,
    parentThreadId: relationship.parentThreadId,
    profileId: relationship.profileId,
    profileName: relationship.profileName,
    projectId: relationship.projectId,
    ...(relationship.kind === "reserved" ? { reservationId: relationship.reservationId } : { threadId: relationship.threadId }),
    title: relationship.title,
    updatedAt: relationship.updatedAt,
  }));
  return createHash("sha256").update(JSON.stringify({
    globals: [...globals].sort((left, right) => left.id.localeCompare(right.id)),
    projects: [...projects].sort((left, right) => left.projectId.localeCompare(right.projectId)),
    relationships: relationshipRows,
  })).digest("hex");
}
