/*
 * Exports:
 * - WorkbenchClientStateRecord/WorkbenchClientStateIdentity: typed app-owned state records and deletion identities. Keywords: app, state, contract.
 * - WorkbenchClientStateRows/WorkbenchClientStateResponse: schema-derived selected rows in a complete snapshot or revision delta. Keywords: app, state, revision, HTTP.
 * - WorkbenchClientStateMutation: focused state mutation payload admitted by app state routes. Keywords: app, state, mutation.
 * - workbenchClientStateMutationPath/workbenchClientStateMutationKinds: shared focused-route registry for browser and app. Keywords: app, state, HTTP, route.
 * - WorkbenchComposerSettingsValue: exact durable custom composer settings. Keywords: composer, profile, settings.
 */
import { appStateClientTables } from "./workbench-app-state-schema.ts";
import type { SelectRow } from "../database/schema/schema-definition.ts";

export type WorkbenchHarnessValue = "codex" | "copilot" | "opencode";
export type WorkbenchThemeValue = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamilyValue = "mono" | "sans" | "serif";
export type WorkbenchFileOpenBehaviorValue = "vscode" | "workbench" | "workbench-or-vscode";

export interface WorkbenchComposerSettingsValue {
  agentPath: string | null;
  agentSource: "library" | "project" | null;
  harness: WorkbenchHarnessValue;
  model: string;
  reasoningEffort: string | null;
  serviceTier: "fast" | null;
}

export type WorkbenchGlobalPreference =
  | { key: "composerSpellCheck" | "editorSpellCheck" | "showUnopenableFiles" | "threadCodeBlockWrap" | "threadLiveActivityOpen"; value: boolean }
  | { key: "editorFontFamily"; value: WorkbenchEditorFontFamilyValue }
  | { key: "appPort" | "editorFontSize"; value: number }
  | { key: "fileOpenBehavior"; value: WorkbenchFileOpenBehaviorValue }
  | { key: "harness"; value: WorkbenchHarnessValue }
  | { key: "theme"; value: WorkbenchThemeValue };

export type WorkbenchProjectPreference =
  | { enabled: boolean; key: "composerSpellCheck" | "editorSpellCheck" | "showUnopenableFiles" | "threadCodeBlockWrap"; value: boolean }
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

export type WorkbenchProfilePreferenceValue =
  | { kind: "custom"; settings: WorkbenchComposerSettingsValue }
  | { kind: "daemon-profile"; profileId: string };

export type WorkbenchClientStateRecord =
  | { kind: "globalPreference"; preference: WorkbenchGlobalPreference }
  | (ProjectScoped & { kind: "projectPreference"; preference: WorkbenchProjectPreference })
  | (ProjectScoped & { kind: "sidebarPreference"; preference: WorkbenchSidebarPreference })
  | (ProjectScoped & { folderId: string; kind: "sidebarFolder"; scope: "pinned" | "thread" })
  | (ProjectScoped & { kind: "expandedDirectory"; path: string })
  | (DaemonScoped & { agentPath: string | null; harness: WorkbenchHarnessValue; kind: "harnessPreference"; model: string | null; serviceTier: "fast" | null })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "modelEffort"; model: string; reasoningEffort: string | null })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "threadServiceTier"; serviceTier: "fast" | null; threadId: string })
  | (ProjectScoped & { kind: "newThreadProfilePreference"; value: WorkbenchProfilePreferenceValue })
  | (ProjectScoped & { draftId: string; harness: WorkbenchHarnessValue; kind: "draftProfilePreference"; value: WorkbenchProfilePreferenceValue })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "threadProfilePreference"; threadId: string; value: WorkbenchProfilePreferenceValue })
  | (ProjectScoped & { kind: "fileDraft"; path: string; value: WorkbenchFileDraftValue })
  | (ProjectScoped & { kind: "composerDraft"; threadId: string; value: WorkbenchComposerDraftValue })
  | (ProjectScoped & { kind: "questionnaireDraft"; requestKey: string; threadId: string; value: WorkbenchQuestionnaireDraftValue })
  | (DaemonScoped & { kind: "lastLaunchTarget"; projectId: string });

export type WorkbenchClientStateIdentity =
  | { kind: "globalPreference"; key: WorkbenchGlobalPreference["key"] }
  | (ProjectScoped & { key: WorkbenchProjectPreference["key"]; kind: "projectPreference" })
  | (ProjectScoped & { key: WorkbenchSidebarPreference["key"]; kind: "sidebarPreference" })
  | (ProjectScoped & { folderId: string; kind: "sidebarFolder"; scope: "pinned" | "thread" })
  | (ProjectScoped & { kind: "expandedDirectory"; path: string })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "harnessPreference" })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "modelEffort"; model: string })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "threadServiceTier"; threadId: string })
  | (ProjectScoped & { kind: "newThreadProfilePreference" })
  | (ProjectScoped & { draftId: string; harness: WorkbenchHarnessValue; kind: "draftProfilePreference" })
  | (DaemonScoped & { harness: WorkbenchHarnessValue; kind: "threadProfilePreference"; threadId: string })
  | (ProjectScoped & { kind: "fileDraft"; path: string })
  | (ProjectScoped & { kind: "composerDraft"; threadId: string })
  | (ProjectScoped & { kind: "questionnaireDraft"; requestKey: string; threadId: string })
  | { kind: "lastLaunchTarget" };

export type WorkbenchClientStateRows = {
  -readonly [Name in keyof typeof appStateClientTables]: SelectRow<(typeof appStateClientTables)[Name]>[];
};

interface WorkbenchClientStateVersion {
  daemonRegistrationId: string;
  oldestAvailableRevision: number;
  revision: number;
}

export type WorkbenchClientStateResponse =
  | (WorkbenchClientStateVersion & { kind: "snapshot"; rows: WorkbenchClientStateRows })
  | (WorkbenchClientStateVersion & { kind: "delta"; rows: WorkbenchClientStateRows });

export type WorkbenchClientStateMutation =
  | { action: "put"; record: WorkbenchClientStateRecord }
  | { action: "delete"; identity: WorkbenchClientStateIdentity };

const mutationPathByKind = {
  composerDraft: "/api/workbench-client-state/composer-draft",
  draftProfilePreference: "/api/workbench-client-state/profile-preference",
  expandedDirectory: "/api/workbench-client-state/expanded-directory",
  fileDraft: "/api/workbench-client-state/file-draft",
  globalPreference: "/api/workbench-client-state/global-preference",
  harnessPreference: "/api/workbench-client-state/harness-preference",
  lastLaunchTarget: "/api/workbench-client-state/launch-target",
  modelEffort: "/api/workbench-client-state/model-effort",
  newThreadProfilePreference: "/api/workbench-client-state/profile-preference",
  projectPreference: "/api/workbench-client-state/project-preference",
  questionnaireDraft: "/api/workbench-client-state/questionnaire-draft",
  sidebarFolder: "/api/workbench-client-state/sidebar-folder",
  sidebarPreference: "/api/workbench-client-state/sidebar-preference",
  threadProfilePreference: "/api/workbench-client-state/profile-preference",
  threadServiceTier: "/api/workbench-client-state/thread-service-tier",
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
