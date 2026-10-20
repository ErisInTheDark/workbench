/*
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE: initial editor zoom.
 * - MIN_EDITOR_FONT_SIZE: minimum editor zoom.
 * - MAX_EDITOR_FONT_SIZE: maximum editor zoom.
 * - WorkbenchTheme: theme choices.
 * - WorkbenchEditorFontFamily: editor font choices.
 * - WorkbenchFileOpenPolicy: per-file-kind open destinations.
 * - WorkbenchSettingKey: configurable identities.
 * - WorkbenchGlobalSettings: global preference values.
 * - WorkbenchProjectSettings: project override slots.
 * - WorkbenchResolvedSettings: effective preference values.
 * - WorkbenchProjectSettingOverride: one override value and enablement.
 * - WorkbenchSettingDefinition: control metadata.
 * - WorkbenchGlobalSidebarPreferences: global sidebar state.
 * - WorkbenchProjectSidebarPreferences: project sidebar state.
 * - WorkbenchSidebarPreferences: combined sidebar state.
 * - WORKBENCH_SETTING_DEFINITIONS: shared control registry.
 * - createDefaultGlobalWorkbenchSettings: global defaults.
 * - createDefaultProjectWorkbenchSettings: disabled project overrides.
 * - createDefaultWorkbenchGlobalSidebarPreferences: global sidebar defaults.
 * - createDefaultWorkbenchProjectSidebarPreferences: project sidebar defaults.
 * - readGlobalWorkbenchSettings: project global records into preferences.
 * - writeGlobalWorkbenchSetting: persist one global intent.
 * - readProjectWorkbenchSettings: project scoped override records.
 * - writeProjectWorkbenchSetting: persist one project override.
 * - readLogicalProjectWorkbenchSettings: logical-project override records.
 * - writeLogicalProjectWorkbenchSetting: persist one logical-project override.
 * - readWorkbenchGlobalSidebarPreferences: project global sidebar records.
 * - writeWorkbenchGlobalSidebarPreference: persist one global sidebar intent.
 * - readWorkbenchProjectSidebarPreferences: project scoped sidebar records.
 * - readWorkbenchSidebarOpenFolders: open folders, each under its own logical project.
 * - writeWorkbenchProjectSidebarPreference: persist one project sidebar intent.
 * - setWorkbenchSidebarFolderOpen: persist one folder's disclosure under its own project.
 * - resolveWorkbenchSettings: merge overrides over global preferences.
 */
import type {
  WorkbenchClientStateRecord,
  WorkbenchGlobalPreference,
  WorkbenchSidebarPreference,
} from "workbench-shared/state/workbench-client-state";
import { FolderIdSchema, LogicalProjectIdSchema, type LogicalProjectId } from "workbench-shared/workbench/identity";
import { getWorkbenchHomeFolderKey } from "workbench-shared/workbench/thread/home-thread-display-order";
import {
  WORKBENCH_SETTING_DEFINITIONS,
  type WorkbenchEditorFontFamily,
  type WorkbenchFileOpenPolicy,
  type WorkbenchFileOpenSettingKey,
  type WorkbenchGlobalSettings,
  type WorkbenchOtherFileOpenDestination,
  type WorkbenchProjectSettingKey,
  type WorkbenchSettingKey,
  type WorkbenchTheme,
  type WorkbenchThreadAnimationStyle,
  type WorkbenchViewableFileOpenDestination,
  USER_NAME_MAX_LENGTH,
} from "workbench-shared/workbench/settings/workbench-setting-definitions";

import { DEFAULT_MARK_TAGS, MarkTag } from "workbench-shared/workbench/settings/mark-tags";

import WorkbenchClientStateController from "./WorkbenchClientStateController";

export {
  WORKBENCH_SETTING_DEFINITIONS,
  type WorkbenchEditorFontFamily,
  type WorkbenchFileOpenPolicy,
  type WorkbenchGlobalSettings,
  type WorkbenchProjectSettingKey,
  type WorkbenchSettingDefinition,
  type WorkbenchSettingKey,
  type WorkbenchTheme,
  type WorkbenchThreadAnimationStyle,
} from "workbench-shared/workbench/settings/workbench-setting-definitions";

export const DEFAULT_EDITOR_FONT_SIZE = 1.08;
export const MIN_EDITOR_FONT_SIZE = 0.84;
export const MAX_EDITOR_FONT_SIZE = 1.72;

export type WorkbenchResolvedSettings = WorkbenchGlobalSettings;

export type WorkbenchProjectSettingOverride<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
  enabled: boolean;
  value: WorkbenchGlobalSettings[K];
};

export type WorkbenchProjectSettings = {
  [K in WorkbenchProjectSettingKey]: WorkbenchProjectSettingOverride<K>;
};

export interface WorkbenchGlobalSidebarPreferences {
  projectStatusCountsExpanded: boolean;
  projectsOpen: boolean;
  projectTimeGroupCount: number;
  reloadNecessaryOpen: boolean;
  sidebarCollapsed: boolean;
}

export interface WorkbenchProjectSidebarPreferences {
  browseSessionsOpen: boolean;
  explorerOpen: boolean;
  pinnedStatusCountsExpanded: boolean;
  pinnedThreadsOpen: boolean;
  threadsOpen: boolean;
}

export type WorkbenchSidebarPreferences =
  & WorkbenchGlobalSidebarPreferences
  & WorkbenchProjectSidebarPreferences;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampEditorFontSize(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (Number.isNaN(numericValue)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, numericValue));
}

function normalizeTheme(value: unknown): WorkbenchTheme {
  return value === "magical-girl" || value === "winter" ? value : "default";
}

function normalizeThreadAnimationStyle(value: unknown): WorkbenchThreadAnimationStyle {
  return WORKBENCH_SETTING_DEFINITIONS.threadAnimationStyle.options?.find(option => option.value === value)?.value ?? "soft";
}

function normalizeEditorFontFamily(value: unknown): WorkbenchEditorFontFamily {
  return value === "serif" || value === "mono" ? value : "sans";
}

function normalizeViewableFileOpen(value: unknown): WorkbenchViewableFileOpenDestination {
  return value === "vscode" ? "vscode" : "workbench";
}

function normalizeOtherFileOpen(value: unknown): WorkbenchOtherFileOpenDestination {
  return value === "none" ? "none" : "vscode";
}

/** The single `fileOpenBehavior` policy predates per-kind rows; each kind falls back to it until written. */
function legacyFileOpenPolicy(value: unknown): WorkbenchFileOpenPolicy | null {
  if (value !== "workbench" && value !== "workbench-or-vscode" && value !== "vscode") return null;
  const viewable = value === "vscode" ? "vscode" : "workbench";
  return {
    openMarkdownFilesWith: viewable,
    openOtherFilesWith: value === "workbench" ? "none" : "vscode",
    openSvgFilesWith: viewable,
  };
}

function normalizeGitPeerSyncMode(value: unknown): WorkbenchGlobalSettings["gitPeerSyncMode"] {
  return value === "rebase" ? "rebase" : "merge";
}

function normalizeUserName(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, USER_NAME_MAX_LENGTH) : "";
}

/** An unwritten list keeps the defaults; a written one, even empty, is the user's. */
function normalizeMarkTags(value: unknown): readonly MarkTag[] {
  return value === undefined ? DEFAULT_MARK_TAGS : MarkTag.normalizeList(value);
}

function normalizeGlobalWorkbenchSettings(value: unknown): WorkbenchGlobalSettings {
  const candidate = isRecord(value) ? value : {};
  const legacy = legacyFileOpenPolicy(candidate.fileOpenBehavior);
  return {
    composerSpellCheck: typeof candidate.composerSpellCheck === "boolean" ? candidate.composerSpellCheck : false,
    editorFontFamily: normalizeEditorFontFamily(candidate.editorFontFamily),
    editorFontSize: clampEditorFontSize(candidate.editorFontSize),
    editorSpellCheck: typeof candidate.editorSpellCheck === "boolean" ? candidate.editorSpellCheck : false,
    markTags: normalizeMarkTags(candidate.markTags),
    openMarkdownFilesWith: normalizeViewableFileOpen(candidate.openMarkdownFilesWith ?? legacy?.openMarkdownFilesWith),
    openOtherFilesWith: normalizeOtherFileOpen(candidate.openOtherFilesWith ?? legacy?.openOtherFilesWith),
    openSvgFilesWith: normalizeViewableFileOpen(candidate.openSvgFilesWith ?? legacy?.openSvgFilesWith),
    gitPeerSyncMode: normalizeGitPeerSyncMode(candidate.gitPeerSyncMode),
    showUnopenableFiles: typeof candidate.showUnopenableFiles === "boolean" ? candidate.showUnopenableFiles : false,
    theme: normalizeTheme(candidate.theme),
    threadAnimationStyle: normalizeThreadAnimationStyle(candidate.threadAnimationStyle),
    threadAnimationPerParagraph: typeof candidate.threadAnimationPerParagraph === "boolean" ? candidate.threadAnimationPerParagraph : false,
    threadCodeBlockWrap: typeof candidate.threadCodeBlockWrap === "boolean" ? candidate.threadCodeBlockWrap : false,
    threadCodeDetails: typeof candidate.threadCodeDetails === "boolean" ? candidate.threadCodeDetails : false,
    userName: normalizeUserName(candidate.userName),
  };
}

function normalizeProjectOverride<K extends WorkbenchProjectSettingKey>(
  key: K,
  value: unknown,
): WorkbenchProjectSettingOverride<K> {
  const candidate = isRecord(value) ? value : {};
  const enabled = candidate.enabled === true;
  const defaultValue = createDefaultProjectWorkbenchSettings()[key].value;

  switch (key) {
    case "gitPeerSyncMode":
      return { enabled, value: normalizeGitPeerSyncMode(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "theme":
      return { enabled, value: normalizeTheme(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "editorFontFamily":
      return { enabled, value: normalizeEditorFontFamily(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "openMarkdownFilesWith":
    case "openSvgFilesWith":
      return { enabled, value: normalizeViewableFileOpen(candidate.value ?? defaultValue) } as WorkbenchProjectSettingOverride<K>;
    case "openOtherFilesWith":
      return { enabled, value: normalizeOtherFileOpen(candidate.value ?? defaultValue) } as WorkbenchProjectSettingOverride<K>;
    case "editorFontSize":
      return { enabled, value: clampEditorFontSize(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "userName":
      return { enabled, value: normalizeUserName(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "markTags":
      return { enabled, value: normalizeMarkTags(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "editorSpellCheck":
    case "composerSpellCheck":
    case "showUnopenableFiles":
    case "threadCodeBlockWrap":
    case "threadCodeDetails":
      return {
        enabled,
        value: typeof candidate.value === "boolean" ? candidate.value : defaultValue,
      } as WorkbenchProjectSettingOverride<K>;
  }
}

export function createDefaultGlobalWorkbenchSettings(): WorkbenchGlobalSettings {
  return {
    composerSpellCheck: false,
    editorFontFamily: "sans",
    editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
    editorSpellCheck: false,
    markTags: DEFAULT_MARK_TAGS,
    openMarkdownFilesWith: "workbench",
    openOtherFilesWith: "vscode",
    openSvgFilesWith: "workbench",
    gitPeerSyncMode: "merge",
    showUnopenableFiles: false,
    theme: "default",
    threadAnimationStyle: "soft",
    threadAnimationPerParagraph: false,
    threadCodeBlockWrap: false,
    threadCodeDetails: false,
    userName: "",
  };
}

export function createDefaultProjectWorkbenchSettings(): WorkbenchProjectSettings {
  const globalDefaults = createDefaultGlobalWorkbenchSettings();
  return {
    composerSpellCheck: { enabled: false, value: globalDefaults.composerSpellCheck },
    editorFontFamily: { enabled: false, value: globalDefaults.editorFontFamily },
    editorFontSize: { enabled: false, value: globalDefaults.editorFontSize },
    editorSpellCheck: { enabled: false, value: globalDefaults.editorSpellCheck },
    markTags: { enabled: false, value: globalDefaults.markTags },
    openMarkdownFilesWith: { enabled: false, value: globalDefaults.openMarkdownFilesWith },
    openOtherFilesWith: { enabled: false, value: globalDefaults.openOtherFilesWith },
    openSvgFilesWith: { enabled: false, value: globalDefaults.openSvgFilesWith },
    gitPeerSyncMode: { enabled: false, value: globalDefaults.gitPeerSyncMode },
    showUnopenableFiles: { enabled: false, value: globalDefaults.showUnopenableFiles },
    theme: { enabled: false, value: globalDefaults.theme },
    threadCodeBlockWrap: { enabled: false, value: globalDefaults.threadCodeBlockWrap },
    threadCodeDetails: { enabled: false, value: globalDefaults.threadCodeDetails },
    userName: { enabled: false, value: globalDefaults.userName },
  };
}

export function createDefaultWorkbenchGlobalSidebarPreferences(): WorkbenchGlobalSidebarPreferences {
  return {
    projectStatusCountsExpanded: true,
    projectsOpen: false,
    projectTimeGroupCount: 1,
    reloadNecessaryOpen: true,
    sidebarCollapsed: false,
  };
}

export function createDefaultWorkbenchProjectSidebarPreferences(): WorkbenchProjectSidebarPreferences {
  return {
    browseSessionsOpen: true,
    explorerOpen: true,
    pinnedStatusCountsExpanded: true,
    pinnedThreadsOpen: true,
    threadsOpen: true,
  };
}

function normalizeProjectTimeGroupCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.floor(value)))
    : createDefaultWorkbenchGlobalSidebarPreferences().projectTimeGroupCount;
}

const WORKBENCH_GLOBAL_SIDEBAR_PROJECT_ID = "";
const WORKBENCH_GLOBAL_SIDEBAR_SCHEMA_VERSION = 4;

function applyWorkbenchGlobalSidebarPreference(
  preferences: WorkbenchGlobalSidebarPreferences,
  preference: WorkbenchGlobalPreference | WorkbenchSidebarPreference,
) {
  switch (preference.key) {
    case "projectStatusCountsExpanded":
    case "projectsOpen":
    case "reloadNecessaryOpen":
    case "sidebarCollapsed":
      preferences[preference.key] = preference.value;
      break;
    case "projectTimeGroupCount":
      preferences.projectTimeGroupCount = normalizeProjectTimeGroupCount(preference.value);
      break;
  }
}

export function readWorkbenchGlobalSidebarPreferences(
  daemonRegistrationId: string,
  records: readonly WorkbenchClientStateRecord[] = [],
): WorkbenchGlobalSidebarPreferences {
  const preferences = createDefaultWorkbenchGlobalSidebarPreferences();
  for (const record of records) {
    if (record.kind !== "sidebarPreference"
      || record.daemonRegistrationId !== daemonRegistrationId
      || record.projectId !== WORKBENCH_GLOBAL_SIDEBAR_PROJECT_ID) continue;
    applyWorkbenchGlobalSidebarPreference(preferences, record.preference);
  }
  for (const record of records) {
    if (record.kind !== "globalPreference") continue;
    applyWorkbenchGlobalSidebarPreference(preferences, record.preference);
  }
  return preferences;
}

export async function writeWorkbenchGlobalSidebarPreference<
  Key extends keyof WorkbenchGlobalSidebarPreferences,
>(
  controller: WorkbenchClientStateController,
  schemaVersion: number,
  key: Key,
  value: WorkbenchGlobalSidebarPreferences[Key],
) {
  const normalizedValue = key === "projectTimeGroupCount"
    ? normalizeProjectTimeGroupCount(value)
    : value;
  if (schemaVersion < WORKBENCH_GLOBAL_SIDEBAR_SCHEMA_VERSION) {
    await controller.put({
      daemonRegistrationId: controller.daemonRegistrationId,
      kind: "sidebarPreference",
      preference: { key, value: normalizedValue } as WorkbenchSidebarPreference,
      projectId: WORKBENCH_GLOBAL_SIDEBAR_PROJECT_ID,
    });
    return;
  }
  await controller.put({
    kind: "globalPreference",
    preference: { key, value: normalizedValue },
  } as Extract<WorkbenchClientStateRecord, { kind: "globalPreference" }>);
}

export function readGlobalWorkbenchSettings(records: readonly WorkbenchClientStateRecord[] = []) {
  const values = Object.fromEntries(records.flatMap((record) => (
    record.kind === "globalPreference"
      ? [[record.preference.key, record.preference.value]]
      : []
  )));
  return normalizeGlobalWorkbenchSettings(values);
}

export async function writeGlobalWorkbenchSetting<K extends WorkbenchSettingKey>(
  controller: WorkbenchClientStateController,
  key: K,
  value: WorkbenchGlobalSettings[K],
) {
  const normalizedValue = normalizeGlobalWorkbenchSettings({
    ...createDefaultGlobalWorkbenchSettings(),
    [key]: value,
  })[key];
  await controller.put({
    kind: "globalPreference",
    preference: { key, value: normalizedValue },
  } as Extract<WorkbenchClientStateRecord, { kind: "globalPreference" }>);
}

function normalizePreferenceOverrides(candidate: Record<string, unknown>): WorkbenchProjectSettings {
  const legacyOverride = isRecord(candidate.fileOpenBehavior) ? candidate.fileOpenBehavior : null;
  const legacy = legacyFileOpenPolicy(legacyOverride?.value);
  const fileOpenOverride = <K extends WorkbenchFileOpenSettingKey>(key: K) => normalizeProjectOverride(key,
    candidate[key] ?? (legacy ? { enabled: legacyOverride?.enabled, value: legacy[key] } : undefined));
  return {
    composerSpellCheck: normalizeProjectOverride("composerSpellCheck", candidate.composerSpellCheck),
    editorFontFamily: normalizeProjectOverride("editorFontFamily", candidate.editorFontFamily),
    editorFontSize: normalizeProjectOverride("editorFontSize", candidate.editorFontSize),
    editorSpellCheck: normalizeProjectOverride("editorSpellCheck", candidate.editorSpellCheck),
    markTags: normalizeProjectOverride("markTags", candidate.markTags),
    openMarkdownFilesWith: fileOpenOverride("openMarkdownFilesWith"),
    openOtherFilesWith: fileOpenOverride("openOtherFilesWith"),
    openSvgFilesWith: fileOpenOverride("openSvgFilesWith"),
    gitPeerSyncMode: normalizeProjectOverride("gitPeerSyncMode", candidate.gitPeerSyncMode),
    showUnopenableFiles: normalizeProjectOverride("showUnopenableFiles", candidate.showUnopenableFiles),
    theme: normalizeProjectOverride("theme", candidate.theme),
    threadCodeBlockWrap: normalizeProjectOverride("threadCodeBlockWrap", candidate.threadCodeBlockWrap),
    threadCodeDetails: normalizeProjectOverride("threadCodeDetails", candidate.threadCodeDetails),
    userName: normalizeProjectOverride("userName", candidate.userName),
  } satisfies WorkbenchProjectSettings;
}

export function readProjectWorkbenchSettings(
  daemonRegistrationId: string,
  projectId: string,
  records: readonly WorkbenchClientStateRecord[] = [],
) {
  const candidate = Object.fromEntries(records.flatMap((record) => (
    record.kind === "projectPreference"
    && record.daemonRegistrationId === daemonRegistrationId
    && record.projectId === projectId
      ? [[record.preference.key, record.preference]]
      : []
  )));
  return normalizePreferenceOverrides(candidate);
}

/** Daemon-scoped project rows predate list-valued settings, which only logical projects override. */
export async function writeProjectWorkbenchSetting<K extends Exclude<WorkbenchProjectSettingKey, "markTags">>(
  controller: WorkbenchClientStateController,
  projectId: string,
  key: K,
  override: WorkbenchProjectSettingOverride<K>,
) {
  await controller.put({
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "projectPreference",
    preference: { ...normalizeProjectOverride(key, override), key } as never,
    projectId,
  });
}

export function readLogicalProjectWorkbenchSettings(
  logicalProjectId: LogicalProjectId | null,
  records: readonly WorkbenchClientStateRecord[] = [],
): WorkbenchProjectSettings {
  if (!logicalProjectId) return createDefaultProjectWorkbenchSettings();
  const candidate = Object.fromEntries(records.flatMap(record => (
    record.kind === "logicalProjectPreference" && record.logicalProjectId === logicalProjectId
      ? [[record.preference.key, record.preference]]
      : []
  )));
  return normalizePreferenceOverrides(candidate);
}

export async function writeLogicalProjectWorkbenchSetting<K extends WorkbenchProjectSettingKey>(
  controller: WorkbenchClientStateController,
  logicalProjectId: LogicalProjectId,
  key: K,
  override: WorkbenchProjectSettingOverride<K>,
) {
  await controller.put({
    kind: "logicalProjectPreference",
    logicalProjectId: LogicalProjectIdSchema.parse(logicalProjectId),
    preference: { ...normalizeProjectOverride(key, override), key } as never,
  });
}

export function readWorkbenchProjectSidebarPreferences(
  daemonRegistrationId: string,
  projectId: string,
  records: readonly WorkbenchClientStateRecord[] = [],
): WorkbenchProjectSidebarPreferences {
  const preferences = { ...createDefaultWorkbenchProjectSidebarPreferences() };
  for (const record of records) {
    if (record.kind === "sidebarPreference"
      && record.daemonRegistrationId === daemonRegistrationId
      && record.projectId === projectId) {
      switch (record.preference.key) {
        case "browseSessionsOpen":
        case "explorerOpen":
        case "pinnedStatusCountsExpanded":
        case "pinnedThreadsOpen":
        case "threadsOpen":
          preferences[record.preference.key] = record.preference.value;
          break;
      }
    }
  }
  return preferences;
}

/** Open folders as home folder keys; each folder's disclosure belongs to its own logical project, not the viewed one. */
export function readWorkbenchSidebarOpenFolders(
  daemonRegistrationId: string,
  records: readonly WorkbenchClientStateRecord[] = [],
): readonly { projectId: string; folderId: string; key: string }[] {
  return records.flatMap((record) => {
    if (record.kind !== "sidebarFolder" || record.daemonRegistrationId !== daemonRegistrationId || record.scope !== "thread") return [];
    // Records from before folder-owned disclosure stored a whole key as the folder id; they no longer address a folder.
    const folderId = FolderIdSchema.safeParse(record.folderId);
    return folderId.success
      ? [{ projectId: record.projectId, folderId: record.folderId, key: getWorkbenchHomeFolderKey(record.projectId, folderId.data) }]
      : [];
  });
}

export async function writeWorkbenchProjectSidebarPreference<K extends keyof WorkbenchProjectSidebarPreferences>(
  controller: WorkbenchClientStateController,
  projectId: string,
  key: K,
  value: WorkbenchProjectSidebarPreferences[K],
) {
  await controller.put({
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "sidebarPreference",
    preference: { key, value } as never,
    projectId,
  });
}

export async function setWorkbenchSidebarFolderOpen(
  controller: WorkbenchClientStateController,
  projectId: string,
  folderId: string,
  open: boolean,
) {
  const identity = {
    daemonRegistrationId: controller.daemonRegistrationId,
    folderId,
    kind: "sidebarFolder" as const,
    projectId,
    scope: "thread" as const,
  };
  if (open) {
    await controller.put(identity);
  } else {
    await controller.delete(identity);
  }
}

export function resolveWorkbenchSettings(
  globalSettings: WorkbenchGlobalSettings,
  projectSettings: WorkbenchProjectSettings,
): WorkbenchResolvedSettings {
  return {
    composerSpellCheck: projectSettings.composerSpellCheck.enabled ? projectSettings.composerSpellCheck.value : globalSettings.composerSpellCheck,
    editorFontFamily: projectSettings.editorFontFamily.enabled ? projectSettings.editorFontFamily.value : globalSettings.editorFontFamily,
    editorFontSize: projectSettings.editorFontSize.enabled ? projectSettings.editorFontSize.value : globalSettings.editorFontSize,
    editorSpellCheck: projectSettings.editorSpellCheck.enabled ? projectSettings.editorSpellCheck.value : globalSettings.editorSpellCheck,
    markTags: projectSettings.markTags.enabled ? projectSettings.markTags.value : globalSettings.markTags,
    openMarkdownFilesWith: projectSettings.openMarkdownFilesWith.enabled ? projectSettings.openMarkdownFilesWith.value : globalSettings.openMarkdownFilesWith,
    openOtherFilesWith: projectSettings.openOtherFilesWith.enabled ? projectSettings.openOtherFilesWith.value : globalSettings.openOtherFilesWith,
    openSvgFilesWith: projectSettings.openSvgFilesWith.enabled ? projectSettings.openSvgFilesWith.value : globalSettings.openSvgFilesWith,
    gitPeerSyncMode: projectSettings.gitPeerSyncMode.enabled ? projectSettings.gitPeerSyncMode.value : globalSettings.gitPeerSyncMode,
    showUnopenableFiles: projectSettings.showUnopenableFiles.enabled ? projectSettings.showUnopenableFiles.value : globalSettings.showUnopenableFiles,
    theme: projectSettings.theme.enabled ? projectSettings.theme.value : globalSettings.theme,
    threadAnimationStyle: globalSettings.threadAnimationStyle,
    threadAnimationPerParagraph: globalSettings.threadAnimationPerParagraph,
    threadCodeBlockWrap: projectSettings.threadCodeBlockWrap.enabled ? projectSettings.threadCodeBlockWrap.value : globalSettings.threadCodeBlockWrap,
    threadCodeDetails: projectSettings.threadCodeDetails.enabled ? projectSettings.threadCodeDetails.value : globalSettings.threadCodeDetails,
    userName: projectSettings.userName.enabled ? projectSettings.userName.value : globalSettings.userName,
  };
}
