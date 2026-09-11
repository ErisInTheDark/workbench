/*
 * Exports:
 * - WorkbenchHarnessValue/WorkbenchThemeValue/WorkbenchEditorFontFamilyValue/WorkbenchFileOpenBehaviorValue/WorkbenchSelectedProjectPinPlacementValue/WorkbenchTranscriptModeValue: preference value contracts.
 * - WorkbenchGlobalPreference/WorkbenchProjectPreference/WorkbenchSidebarPreference: typed preference records.
 * - WorkbenchFileDraftValue/WorkbenchComposerDraftValue/WorkbenchQuestionnaireDraftValue: recoverable browser draft values.
 * - WorkbenchClientStateRecord/WorkbenchClientStateIdentity/WorkbenchClientStateMutation: app state records, identities, and mutations.
 * - WorkbenchClientStateRows/WorkbenchClientStateResponse: schema-derived rows, schema capability, and revision responses.
 * - WORKBENCH_BROWSER_STATE_HEADER/isWorkbenchBrowserStateId: browser namespace HTTP boundary.
 * - workbenchClientStateMutationPath/workbenchClientStateMutationKinds: focused-route registry.
 */
import { appStateClientTables } from "./workbench-app-state-schema.ts";
import type { SelectRow } from "../database/schema/schema-definition.ts";

export type WorkbenchHarnessValue = "codex" | "copilot" | "opencode";
export type WorkbenchThemeValue = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamilyValue = "mono" | "sans" | "serif";
export type WorkbenchFileOpenBehaviorValue = "vscode" | "workbench" | "workbench-or-vscode";
export type WorkbenchSelectedProjectPinPlacementValue = "pinned-section" | "threads-section";
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
      | "threadLiveActivityOpen";
    value: boolean;
  }
  | { key: "editorFontFamily"; value: WorkbenchEditorFontFamilyValue }
  | { key: "appPort" | "editorFontSize" | "projectTimeGroupCount"; value: number }
  | { key: "fileOpenBehavior"; value: WorkbenchFileOpenBehaviorValue }
  | { key: "harness"; value: WorkbenchHarnessValue }
  | { key: "selectedProjectPinPlacement"; value: WorkbenchSelectedProjectPinPlacementValue }
  | { key: "theme"; value: WorkbenchThemeValue }
  | { key: "transcriptProjectionMode"; value: WorkbenchTranscriptModeValue };

export type WorkbenchProjectPreference =
  | { enabled: boolean; key: "composerSpellCheck" | "editorSpellCheck" | "showUnopenableFiles" | "threadCodeBlockWrap"; value: boolean }
  | { enabled: boolean; key: "editorFontFamily"; value: WorkbenchEditorFontFamilyValue }
  | { enabled: boolean; key: "editorFontSize"; value: number }
  | { enabled: boolean; key: "fileOpenBehavior"; value: WorkbenchFileOpenBehaviorValue }
  | { enabled: boolean; key: "selectedProjectPinPlacement"; value: WorkbenchSelectedProjectPinPlacementValue }
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
  | { kind: "globalPreference"; preference: WorkbenchGlobalPreference }
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
  | { kind: "globalPreference"; key: WorkbenchGlobalPreference["key"] }
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
  daemonRegistrationId: string;
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

export const WORKBENCH_BROWSER_STATE_HEADER = "x-workbench-browser-state-id";
const WORKBENCH_BROWSER_STATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isWorkbenchBrowserStateId(value: string): boolean {
  return WORKBENCH_BROWSER_STATE_ID_PATTERN.test(value);
}

const mutationPathByKind = {
  modelPreference: "/api/workbench-client-state/model-preference",
  composerDraft: "/api/workbench-client-state/composer-draft",
  expandedDirectory: "/api/workbench-client-state/expanded-directory",
  fileDraft: "/api/workbench-client-state/file-draft",
  globalPreference: "/api/workbench-client-state/global-preference",
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
