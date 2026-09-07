/*
 * Keywords: thread state, source, relational, repair, digest, parity.
 * Exports:
 * - ProjectDocument: parsed project state.
 * - SourceProject: project state with source identity and update time.
 * - asRecord: narrow external object input.
 * - parseProjectDocument: repair current and legacy project documents.
 * - decodeGlobalDocument: decode a global state document.
 * - createSourceDigest: fingerprint source documents and relationship state.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import type { WorkbenchStoredSubagent } from "../../workbench-subagent-store-state.ts";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchComposerSettingsSchema,
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
  const identity = StoredDraftIdentitySchema.safeParse(record);
  if (!identity.success) {
    throw new Error(`Stored project ${projectId} contains a draft without a recoverable identity.`);
  }
  const settings = WorkbenchComposerSettingsSchema.safeParse(record.composerSettings);
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
    agent: null,
    attachments: [],
    clientUpdatedAt: 0,
    composerSettings,
    createdAt: 0,
    draftId: identity.data.draftId,
    harness,
    model: null,
    profileId: null,
    projectId,
    prompt: "",
    reasoningEffort: null,
    serviceTier: null,
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
