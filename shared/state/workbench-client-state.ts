/*
 * Exports:
 * - WorkbenchHarnessValue: provider identity.
 * - WorkbenchThemeValue: theme choices.
 * - WorkbenchEditorFontFamilyValue: editor font choices.
 * - WorkbenchFileOpenBehaviorValue: file opening policy.
 * - WorkbenchSelectedProjectPinPlacementValue: selected-project pin location.
 * - WorkbenchTranscriptModeValue: transcript storage selection.
 * - WorkbenchGlobalPreference: typed global preference.
 * - WorkbenchProjectPreference: typed project override.
 * - WorkbenchSidebarPreference: typed sidebar preference.
 * - WorkbenchFileDraftValue: recoverable file edits.
 * - WorkbenchComposerDraftValue: recoverable composer input.
 * - WorkbenchQuestionnaireDraftValue: recoverable questionnaire answers.
 * - WorkbenchClientStateRecord: persisted browser state variants.
 * - WorkbenchClientStateIdentity: browser state addresses.
 * - WorkbenchClientStateMutation: put/delete intents.
 * - WorkbenchClientStateRecordSchema/WorkbenchClientStateIdentitySchema/WorkbenchClientStateMutationSchema: validate app-state writes.
 * - WorkbenchClientStateAttachmentIdentity: composer or questionnaire image owner.
 * - workbenchClientStateAttachmentUrl: browser-scoped image URL for one saved attachment.
 * - WorkbenchClientStateRows: schema-derived wire rows.
 * - WorkbenchClientStateResponse: versioned snapshots and deltas.
 * - WORKBENCH_BROWSER_STATE_HEADER: browser namespace header.
 * - isWorkbenchBrowserStateId: validate browser namespace.
 * - workbenchClientStateMutationPath: route for a record kind.
 * - workbenchClientStateMutationKinds: record kinds admitted by a route.
 * - WorkbenchProjectRemapSchema: validate project-address adoption.
 * - WorkbenchProjectRemap: daemon-scoped address adoption.
 * - WorkbenchDaemonRegistrationRequestSchema/WorkbenchDaemonRegistrationSchema: durable peer-to-browser registration mapping.
 * - WorkbenchClientStateProjectAliasesSchema: app-owned source-qualified canonical project addresses.
 * - modelGroupDisclosure records: browser-scoped model section visibility.
 */
import { appStateClientTables } from "./workbench-app-state-schema.ts";
import type { SelectRow } from "../database/schema/schema-definition.ts";
import { z } from "zod";
import { WorkbenchProjectAliasSchema } from "../workbench/project/project-state.ts";
import { DaemonIdSchema, LogicalProjectIdSchema, type LogicalProjectId } from "../workbench/identity.ts";
import { ProviderKeySchema } from "../workbench/provider/provider-key.ts";

export const WorkbenchDaemonRegistrationRequestSchema = z.object({
  daemonId: DaemonIdSchema,
  attachedLocal: z.boolean(),
}).strict();
export const WorkbenchDaemonRegistrationSchema = z.object({
  id: z.string().min(1),
  daemonId: DaemonIdSchema.nullable(),
  kind: z.enum(["local", "remote"]),
}).strict();
export type WorkbenchDaemonRegistration = z.infer<typeof WorkbenchDaemonRegistrationSchema>;
export const WorkbenchClientStateProjectAliasesSchema = z.array(z.object({
  daemonRegistrationId: z.string().min(1),
  aliases: z.array(WorkbenchProjectAliasSchema),
}).strict()).default([]);

export const WorkbenchProjectRemapSchema = z.object({
  daemonRegistrationId: z.string().min(1).max(256),
  aliases: z.array(WorkbenchProjectAliasSchema).max(10_000),
}).strict();
export type WorkbenchProjectRemap = z.infer<typeof WorkbenchProjectRemapSchema>;

export type { ProviderKey as WorkbenchHarnessValue } from "../workbench/provider/provider-key.ts";
import type { ProviderKey as WorkbenchHarnessValue } from "../workbench/provider/provider-key.ts";
export type WorkbenchThemeValue = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamilyValue = "mono" | "sans" | "serif";
export type WorkbenchFileOpenBehaviorValue = "vscode" | "workbench" | "workbench-or-vscode";
export type WorkbenchTranscriptModeValue = "compare" | "json" | "sqlite";

export type WorkbenchGlobalPreference =
  | {
    key:
      | "composerSpellCheck"
      | "editorSpellCheck"
      | "projectStatusCountsExpanded"
      | "projectsOpen"
      | "reactDevelopmentMode"
      | "reloadNecessaryOpen"
      | "showUnopenableFiles"
      | "sidebarCollapsed"
      | "threadCodeBlockWrap"
      | "threadCodeDetails"
      | "threadGitArcProposalsOpen";
    value: boolean;
  }
  | {
    key: "voiceInputEnabled";
    value: boolean;
  }
  | { key: "editorFontFamily"; value: WorkbenchEditorFontFamilyValue }
  | { key: "appPort" | "editorFontSize" | "projectTimeGroupCount"; value: number }
  | { key: "fileOpenBehavior"; value: WorkbenchFileOpenBehaviorValue }
  | { key: "harness"; value: WorkbenchHarnessValue }
  | { key: "theme"; value: WorkbenchThemeValue }
  | { key: "transcriptProjectionMode"; value: WorkbenchTranscriptModeValue };

export type WorkbenchProjectPreference =
  | { enabled: boolean; key: "composerSpellCheck" | "editorSpellCheck" | "showUnopenableFiles" | "threadCodeBlockWrap" | "threadCodeDetails"; value: boolean }
  | { enabled: boolean; key: "editorFontFamily"; value: WorkbenchEditorFontFamilyValue }
  | { enabled: boolean; key: "editorFontSize"; value: number }
  | { enabled: boolean; key: "fileOpenBehavior"; value: WorkbenchFileOpenBehaviorValue }
  | { enabled: boolean; key: "theme"; value: WorkbenchThemeValue };

export type WorkbenchSidebarPreference =
  | { key: "projectTimeGroupCount" | "settledThreadItemLimit"; value: number }
  | {
    key:
      | "browseSessionsOpen"
      | "explorerOpen"
      | "pinnedStatusCountsExpanded"
      | "pinnedThreadsOpen"
      | "projectStatusCountsExpanded"
      | "projectsOpen"
      | "reloadNecessaryOpen"
      | "settledThreadsOpen"
      | "sidebarCollapsed"
      | "threadsOpen";
    value: boolean;
  };

interface DaemonScoped {
  daemonRegistrationId: string;
}

interface ProjectScoped extends DaemonScoped {
  projectId: string;
}

export interface WorkbenchFileDraftValue {
  baselineContent: string;
  content: string;
  expectedMtimeMs: number | null;
  headContent: string | null;
  mode: "plain" | "rich";
}

export interface WorkbenchComposerDraftValue {
  attachments: Array<{ id: string; url: string }>;
  text: string;
  updatedAt: number;
}

export interface WorkbenchQuestionnaireDraftValue {
  attachments: Array<{ id: string; url: string }>;
  customValues: Record<string, string>;
  selectedValues: Record<string, string[]>;
  updatedAt: number;
}

export type WorkbenchClientStateRecord =
  | { kind: "modelPreference"; harness: WorkbenchHarnessValue; modelId: string; favourite: boolean }
  | { kind: "modelGroupDisclosure"; groupId: string; open: boolean }
  | { kind: "globalPreference"; preference: WorkbenchGlobalPreference }
  | { kind: "logicalProjectPreference"; logicalProjectId: LogicalProjectId; preference: WorkbenchProjectPreference }
  | (ProjectScoped & { kind: "projectPreference"; preference: WorkbenchProjectPreference })
  | (ProjectScoped & { kind: "sidebarPreference"; preference: WorkbenchSidebarPreference })
  | (ProjectScoped & { folderId: string; kind: "sidebarFolder"; scope: "pinned" | "thread" })
  | (ProjectScoped & { kind: "expandedDirectory"; path: string })
  | (ProjectScoped & { kind: "fileDraft"; path: string; value: WorkbenchFileDraftValue })
  | (ProjectScoped & { kind: "composerDraft"; threadId: string; value: WorkbenchComposerDraftValue })
  | (ProjectScoped & { kind: "questionnaireDraft"; requestKey: string; threadId: string; value: WorkbenchQuestionnaireDraftValue })
  | (DaemonScoped & { kind: "lastLaunchTarget"; projectId: string });

export type WorkbenchClientStateIdentity =
  | { kind: "modelPreference"; harness: WorkbenchHarnessValue; modelId: string }
  | { kind: "modelGroupDisclosure"; groupId: string }
  | { kind: "globalPreference"; key: WorkbenchGlobalPreference["key"] }
  | { kind: "logicalProjectPreference"; logicalProjectId: LogicalProjectId; key: WorkbenchProjectPreference["key"] }
  | (ProjectScoped & { key: WorkbenchProjectPreference["key"]; kind: "projectPreference" })
  | (ProjectScoped & { key: WorkbenchSidebarPreference["key"]; kind: "sidebarPreference" })
  | (ProjectScoped & { folderId: string; kind: "sidebarFolder"; scope: "pinned" | "thread" })
  | (ProjectScoped & { kind: "expandedDirectory"; path: string })
  | (ProjectScoped & { kind: "fileDraft"; path: string })
  | (ProjectScoped & { kind: "composerDraft"; threadId: string })
  | (ProjectScoped & { kind: "questionnaireDraft"; requestKey: string; threadId: string })
  | { kind: "lastLaunchTarget" };

export type WorkbenchClientStateRows = {
  -readonly [Name in keyof typeof appStateClientTables]: SelectRow<(typeof appStateClientTables)[Name]>[];
};

interface WorkbenchClientStateVersion {
  attachmentsAsUrls?: boolean;
  daemonRegistrationId: string;
  registrations?: z.infer<typeof WorkbenchDaemonRegistrationSchema>[];
  projectAliases?: z.infer<typeof WorkbenchClientStateProjectAliasesSchema>;
  oldestAvailableRevision: number;
  revision: number;
  schemaVersion?: number;
}

export type WorkbenchClientStateResponse =
  | (WorkbenchClientStateVersion & { kind: "snapshot"; rows: WorkbenchClientStateRows })
  | (WorkbenchClientStateVersion & { kind: "delta"; rows: WorkbenchClientStateRows });

export type WorkbenchClientStateMutation =
  | { action: "put"; record: WorkbenchClientStateRecord }
  | { action: "delete"; identity: WorkbenchClientStateIdentity };

const address = z.string().min(1);
const preferenceBoolean = z.object({
  key: z.enum([
    "composerSpellCheck", "editorSpellCheck", "projectStatusCountsExpanded", "projectsOpen",
    "reactDevelopmentMode", "reloadNecessaryOpen", "showUnopenableFiles", "sidebarCollapsed",
    "threadCodeBlockWrap", "threadCodeDetails", "threadGitArcProposalsOpen", "voiceInputEnabled",
  ]),
  value: z.boolean(),
});
const GlobalPreferenceSchema = z.union([
  preferenceBoolean,
  z.object({ key: z.literal("editorFontFamily"), value: z.enum(["mono", "sans", "serif"]) }),
  z.object({ key: z.enum(["appPort", "editorFontSize", "projectTimeGroupCount"]), value: z.number() }),
  z.object({ key: z.literal("fileOpenBehavior"), value: z.enum(["vscode", "workbench", "workbench-or-vscode"]) }),
  z.object({ key: z.literal("harness"), value: ProviderKeySchema }),
  z.object({ key: z.literal("theme"), value: z.enum(["default", "magical-girl", "winter"]) }),
  z.object({ key: z.literal("transcriptProjectionMode"), value: z.enum(["compare", "json", "sqlite"]) }),
]);
const ProjectPreferenceSchema = z.union([
  z.object({ enabled: z.boolean(), key: z.enum([
    "composerSpellCheck", "editorSpellCheck", "showUnopenableFiles", "threadCodeBlockWrap", "threadCodeDetails",
  ]), value: z.boolean() }),
  z.object({ enabled: z.boolean(), key: z.literal("editorFontFamily"), value: z.enum(["mono", "sans", "serif"]) }),
  z.object({ enabled: z.boolean(), key: z.literal("editorFontSize"), value: z.number() }),
  z.object({ enabled: z.boolean(), key: z.literal("fileOpenBehavior"), value: z.enum(["vscode", "workbench", "workbench-or-vscode"]) }),
  z.object({ enabled: z.boolean(), key: z.literal("theme"), value: z.enum(["default", "magical-girl", "winter"]) }),
]);
const SidebarPreferenceSchema = z.union([
  z.object({ key: z.enum(["projectTimeGroupCount", "settledThreadItemLimit"]), value: z.number() }),
  z.object({ key: z.enum([
    "browseSessionsOpen", "explorerOpen", "pinnedStatusCountsExpanded", "pinnedThreadsOpen",
    "projectStatusCountsExpanded", "projectsOpen", "reloadNecessaryOpen", "settledThreadsOpen",
    "sidebarCollapsed", "threadsOpen",
  ]), value: z.boolean() }),
]);
const projectAddress = { daemonRegistrationId: address, projectId: address };
const attachment = z.object({ id: address, url: z.string() });

export const WorkbenchClientStateRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("modelPreference"), harness: ProviderKeySchema,
    modelId: z.string(), favourite: z.boolean() }),
  z.object({ kind: z.literal("modelGroupDisclosure"), groupId: z.string().min(1).max(600), open: z.boolean() }),
  z.object({ kind: z.literal("globalPreference"), preference: GlobalPreferenceSchema }),
  z.object({ kind: z.literal("logicalProjectPreference"), logicalProjectId: LogicalProjectIdSchema,
    preference: ProjectPreferenceSchema }),
  z.object({ kind: z.literal("projectPreference"), ...projectAddress,
    preference: ProjectPreferenceSchema }),
  z.object({ kind: z.literal("sidebarPreference"), ...projectAddress,
    preference: SidebarPreferenceSchema }),
  z.object({ kind: z.literal("sidebarFolder"), ...projectAddress, folderId: address,
    scope: z.enum(["pinned", "thread"]) }),
  z.object({ kind: z.literal("expandedDirectory"), ...projectAddress, path: z.string() }),
  z.object({ kind: z.literal("fileDraft"), ...projectAddress, path: z.string(),
    value: z.object({
      baselineContent: z.string(), content: z.string(),
      expectedMtimeMs: z.number().nullable(), headContent: z.string().nullable(),
      mode: z.enum(["plain", "rich"]),
    }) }),
  z.object({ kind: z.literal("composerDraft"), ...projectAddress, threadId: address,
    value: z.object({ attachments: z.array(attachment),
      text: z.string(), updatedAt: z.number() }) }),
  z.object({ kind: z.literal("questionnaireDraft"), ...projectAddress, threadId: address,
    requestKey: address, value: z.object({
      attachments: z.array(attachment),
      customValues: z.record(address, z.string()),
      selectedValues: z.record(address, z.array(z.string())),
      updatedAt: z.number(),
    }) }),
  z.object({ kind: z.literal("lastLaunchTarget"), daemonRegistrationId: address,
    projectId: address }),
]);

export const WorkbenchClientStateIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("modelPreference"), harness: ProviderKeySchema, modelId: z.string() }),
  z.object({ kind: z.literal("modelGroupDisclosure"), groupId: z.string().min(1).max(600) }),
  z.object({ kind: z.literal("globalPreference"), key: z.enum([
    "composerSpellCheck", "editorSpellCheck", "projectStatusCountsExpanded", "projectsOpen",
    "reactDevelopmentMode", "reloadNecessaryOpen", "showUnopenableFiles", "sidebarCollapsed",
    "threadCodeBlockWrap", "threadCodeDetails", "threadGitArcProposalsOpen", "voiceInputEnabled",
    "editorFontFamily", "appPort", "editorFontSize", "projectTimeGroupCount", "fileOpenBehavior",
    "harness", "theme", "transcriptProjectionMode",
  ]) }),
  z.object({ kind: z.literal("logicalProjectPreference"), logicalProjectId: LogicalProjectIdSchema,
    key: z.enum(["composerSpellCheck", "editorSpellCheck", "showUnopenableFiles", "threadCodeBlockWrap",
      "threadCodeDetails", "editorFontFamily", "editorFontSize", "fileOpenBehavior",
      "theme"]) }),
  z.object({ kind: z.literal("projectPreference"), ...projectAddress,
    key: z.enum(["composerSpellCheck", "editorSpellCheck", "showUnopenableFiles", "threadCodeBlockWrap",
      "threadCodeDetails", "editorFontFamily", "editorFontSize", "fileOpenBehavior",
      "theme"]) }),
  z.object({ kind: z.literal("sidebarPreference"), ...projectAddress,
    key: z.enum(["projectTimeGroupCount", "settledThreadItemLimit", "browseSessionsOpen", "explorerOpen",
      "pinnedStatusCountsExpanded", "pinnedThreadsOpen", "projectStatusCountsExpanded", "projectsOpen",
      "reloadNecessaryOpen", "settledThreadsOpen", "sidebarCollapsed", "threadsOpen"]) }),
  z.object({ kind: z.literal("sidebarFolder"), ...projectAddress, folderId: address,
    scope: z.enum(["pinned", "thread"]) }),
  z.object({ kind: z.literal("expandedDirectory"), ...projectAddress, path: z.string() }),
  z.object({ kind: z.literal("fileDraft"), ...projectAddress, path: z.string() }),
  z.object({ kind: z.literal("composerDraft"), ...projectAddress, threadId: address }),
  z.object({ kind: z.literal("questionnaireDraft"), ...projectAddress, threadId: address,
    requestKey: address }),
  z.object({ kind: z.literal("lastLaunchTarget") }),
]);

export const WorkbenchClientStateMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("put"), record: WorkbenchClientStateRecordSchema }),
  z.object({ action: z.literal("delete"), identity: WorkbenchClientStateIdentitySchema }),
]);

export type WorkbenchClientStateAttachmentIdentity = Extract<
  WorkbenchClientStateIdentity,
  { kind: "composerDraft" | "questionnaireDraft" }
>;

export function workbenchClientStateAttachmentUrl(
  browserStateId: string,
  identity: WorkbenchClientStateAttachmentIdentity,
  attachmentId: string,
) {
  const query = new URLSearchParams({
    attachmentId,
    browserStateId,
    daemonRegistrationId: identity.daemonRegistrationId,
    kind: identity.kind,
    projectId: identity.projectId,
    threadId: identity.threadId,
    ...("requestKey" in identity ? { requestKey: identity.requestKey } : {}),
  });
  return `/api/workbench-client-state/attachment?${query}`;
}

export const WORKBENCH_BROWSER_STATE_HEADER = "x-workbench-browser-state-id";
const WORKBENCH_BROWSER_STATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isWorkbenchBrowserStateId(value: string): boolean {
  return WORKBENCH_BROWSER_STATE_ID_PATTERN.test(value);
}

const mutationPathByKind = {
  modelPreference: "/api/workbench-client-state/model-preference",
  modelGroupDisclosure: "/api/workbench-client-state/model-group-disclosure",
  composerDraft: "/api/workbench-client-state/composer-draft",
  expandedDirectory: "/api/workbench-client-state/expanded-directory",
  fileDraft: "/api/workbench-client-state/file-draft",
  globalPreference: "/api/workbench-client-state/global-preference",
  logicalProjectPreference: "/api/workbench-client-state/project-preference",
  lastLaunchTarget: "/api/workbench-client-state/launch-target",
  projectPreference: "/api/workbench-client-state/project-preference",
  questionnaireDraft: "/api/workbench-client-state/questionnaire-draft",
  sidebarFolder: "/api/workbench-client-state/sidebar-folder",
  sidebarPreference: "/api/workbench-client-state/sidebar-preference",
} as const satisfies Record<WorkbenchClientStateRecord["kind"], string>;

const mutationKindsByPath = new Map<string, WorkbenchClientStateRecord["kind"][]>();
for (const [kind, path] of Object.entries(mutationPathByKind)) {
  const kinds = mutationKindsByPath.get(path) ?? [];
  kinds.push(kind as WorkbenchClientStateRecord["kind"]);
  mutationKindsByPath.set(path, kinds);
}

export function workbenchClientStateMutationPath(kind: WorkbenchClientStateRecord["kind"]) {
  return mutationPathByKind[kind];
}

export function workbenchClientStateMutationKinds(path: string) {
  return mutationKindsByPath.get(path) as readonly WorkbenchClientStateRecord["kind"][] | undefined;
}
