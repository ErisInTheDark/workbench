/*
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE: editor zoom defaults and bounds. Keywords: settings, editor, zoom.
 * - WorkbenchTheme/WorkbenchEditorFontFamily/WorkbenchFileOpenBehavior/WorkbenchSelectedProjectPinPlacement/WorkbenchSettingKey: setting value contracts. Keywords: settings, theme, editor, pinned, thread.
 * - WorkbenchGlobalSettings, WorkbenchProjectSettings, WorkbenchResolvedSettings: stored and resolved settings shapes. Keywords: settings, global, project override.
 * - WorkbenchProjectSidebarPreferences: project-local sidebar display state. Keywords: settings, project, sidebar, disclosure, folders.
 * - WORKBENCH_SETTING_DEFINITIONS: labels and option metadata for settings UI rendering. Keywords: settings, registry, UI.
 * - createDefaultGlobalWorkbenchSettings/createDefaultWorkbenchProjectSidebarPreferences: create agentic global and sidebar defaults. Keywords: settings, defaults, sidebar, agentic.
 * - readGlobalWorkbenchSettings/writeGlobalWorkbenchSetting: project global settings and write one setting intent. Keywords: settings, app state, global.
 * - readProjectWorkbenchSettings/writeProjectWorkbenchSetting: project explicit project override slots and write one override intent. Keywords: settings, app state, project.
 * - readWorkbenchProjectSidebarPreferences/writeWorkbenchProjectSidebarPreference/setWorkbenchProjectSidebarFolderOpen: project sidebar state and focused writes. Keywords: settings, app state, project, sidebar.
 * - resolveWorkbenchSettings: merge project overrides over global settings. Keywords: settings, inheritance, overrides.
 */
import type {
    WorkbenchClientStateRecord,
    WorkbenchSelectedProjectPinPlacementValue,
} from "workbench-shared/state/workbench-client-state";

import WorkbenchClientStateController from "./WorkbenchClientStateController";

export const DEFAULT_EDITOR_FONT_SIZE = 1.08;
export const MIN_EDITOR_FONT_SIZE = 0.84;
export const MAX_EDITOR_FONT_SIZE = 1.72;

export type WorkbenchTheme = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamily = "sans" | "serif" | "mono";
export type WorkbenchFileOpenBehavior = "workbench" | "workbench-or-vscode" | "vscode";
export type WorkbenchSelectedProjectPinPlacement = WorkbenchSelectedProjectPinPlacementValue;
export type WorkbenchSettingKey =
  | "theme"
  | "editorFontFamily"
  | "editorSpellCheck"
  | "composerSpellCheck"
  | "editorFontSize"
  | "fileOpenBehavior"
  | "selectedProjectPinPlacement"
  | "showUnopenableFiles"
  | "threadCodeBlockWrap";

export interface WorkbenchGlobalSettings {
  composerSpellCheck: boolean;
  editorFontFamily: WorkbenchEditorFontFamily;
  editorFontSize: number;
  editorSpellCheck: boolean;
  fileOpenBehavior: WorkbenchFileOpenBehavior;
  selectedProjectPinPlacement: WorkbenchSelectedProjectPinPlacement;
  showUnopenableFiles: boolean;
  theme: WorkbenchTheme;
  threadCodeBlockWrap: boolean;
}

export type WorkbenchResolvedSettings = WorkbenchGlobalSettings;

export type WorkbenchProjectSettingOverride<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
  enabled: boolean;
  value: WorkbenchGlobalSettings[K];
};

export type WorkbenchProjectSettings = {
  [K in WorkbenchSettingKey]: WorkbenchProjectSettingOverride<K>;
};

export interface WorkbenchProjectSidebarPreferences {
  readonly browseSessionsOpen: boolean;
  readonly explorerOpen: boolean;
  readonly pinnedFolderIds: readonly string[];
  readonly pinnedStatusCountsExpanded: boolean;
  readonly pinnedThreadsOpen: boolean;
  readonly projectStatusCountsExpanded: boolean;
  readonly projectsOpen: boolean;
  readonly projectTimeGroupCount: number;
  readonly reloadNecessaryOpen: boolean;
  readonly settledThreadItemLimit: number;
  readonly settledThreadsOpen: boolean;
  readonly sidebarCollapsed: boolean;
  readonly threadFolderIds: readonly string[];
  readonly threadsOpen: boolean;
}

export type WorkbenchSettingDefinition<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
  columns?: "one" | "two";
  description: string;
  key: K;
  label: string;
  options?: Array<{
    description: string;
    label: string;
    value: WorkbenchGlobalSettings[K];
  }>;
  type: "boolean" | "number" | "select";
};

export const WORKBENCH_SETTING_DEFINITIONS: { [K in WorkbenchSettingKey]: WorkbenchSettingDefinition<K> } = {
  composerSpellCheck: {
    description: "Controls spellcheck in thread composers and questionnaire text answers.",
    key: "composerSpellCheck",
    label: "Composer spellcheck",
    type: "boolean",
  },
  editorFontFamily: {
    description: "Controls the body font used by the rich markdown editor.",
    key: "editorFontFamily",
    label: "Editor font",
    options: [
      {
        description: "Agentic default for technical editing.",
        label: "Sans",
        value: "sans",
      },
      {
        description: "Story-writing style with a literary feel.",
        label: "Serif",
        value: "serif",
      },
      {
        description: "Code-adjacent and compact.",
        label: "Mono",
        value: "mono",
      },
    ],
    type: "select",
  },
  editorFontSize: {
    description: "Controls editor and thread text scale.",
    key: "editorFontSize",
    label: "Text size",
    type: "number",
  },
  fileOpenBehavior: {
    description: "Controls whether project file links open in Workbench or VS Code.",
    key: "fileOpenBehavior",
    label: "Open files with",
    options: [
      {
        description: "Open supported markdown files in Workbench and ignore unsupported files.",
        label: "Workbench only",
        value: "workbench",
      },
      {
        description: "Open markdown in Workbench and use VS Code for files Workbench cannot open.",
        label: "Workbench, then VS Code",
        value: "workbench-or-vscode",
      },
      {
        description: "Always ask the local server to open file links in VS Code.",
        label: "VS Code",
        value: "vscode",
      },
    ],
    type: "select",
  },
  selectedProjectPinPlacement: {
    columns: "two",
    description: "Choose where pinned threads from the selected project appear.",
    key: "selectedProjectPinPlacement",
    label: "Selected-project pin placement",
    options: [
      {
        description: "Keep them in the global pinned threads list.",
        label: "Pinned threads",
        value: "pinned-section",
      },
      {
        description: "A pinned section at the top of the project's threads.",
        label: "Threads",
        value: "threads-section",
      },
    ],
    type: "select",
  },
  showUnopenableFiles: {
    description: "Controls whether the project sidebar shows files Workbench cannot open directly.",
    key: "showUnopenableFiles",
    label: "Show unsupported files",
    type: "boolean",
  },
  threadCodeBlockWrap: {
    description: "Controls whether thread markdown code blocks wrap long lines instead of using horizontal scrolling.",
    key: "threadCodeBlockWrap",
    label: "Wrap thread code blocks",
    type: "boolean",
  },
  editorSpellCheck: {
    description: "Controls browser spellcheck in the rich markdown editor.",
    key: "editorSpellCheck",
    label: "Editor spellcheck",
    type: "boolean",
  },
  theme: {
    columns: "two",
    description: "Controls Workbench colors and font personality.",
    key: "theme",
    label: "Theme",
    options: [
      {
        description: "Current quiet Workbench colors and fonts.",
        label: "Default",
        value: "default",
      },
      {
        description: "Pink sparkles with Sour Gummy and Comic Code Light.",
        label: "Magical girl mode",
        value: "magical-girl",
      },
      {
        description: "Snowy day and night colors with the normal Workbench fonts.",
        label: "Winter",
        value: "winter",
      },
    ],
    type: "select",
  },
};

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

function normalizeEditorFontFamily(value: unknown): WorkbenchEditorFontFamily {
  return value === "serif" || value === "mono" ? value : "sans";
}

function normalizeFileOpenBehavior(value: unknown): WorkbenchFileOpenBehavior {
  return value === "workbench-or-vscode" || value === "vscode" ? value : "workbench";
}

function normalizeSelectedProjectPinPlacement(value: unknown): WorkbenchSelectedProjectPinPlacement {
  return value === "threads-section" ? value : "pinned-section";
}

function normalizeGlobalWorkbenchSettings(value: unknown): WorkbenchGlobalSettings {
  const candidate = isRecord(value) ? value : {};
  return {
    composerSpellCheck: typeof candidate.composerSpellCheck === "boolean" ? candidate.composerSpellCheck : false,
    editorFontFamily: normalizeEditorFontFamily(candidate.editorFontFamily),
    editorFontSize: clampEditorFontSize(candidate.editorFontSize),
    editorSpellCheck: typeof candidate.editorSpellCheck === "boolean" ? candidate.editorSpellCheck : false,
    fileOpenBehavior: normalizeFileOpenBehavior(candidate.fileOpenBehavior),
    selectedProjectPinPlacement: normalizeSelectedProjectPinPlacement(candidate.selectedProjectPinPlacement),
    showUnopenableFiles: typeof candidate.showUnopenableFiles === "boolean" ? candidate.showUnopenableFiles : false,
    theme: normalizeTheme(candidate.theme),
    threadCodeBlockWrap: typeof candidate.threadCodeBlockWrap === "boolean" ? candidate.threadCodeBlockWrap : false,
  };
}

function normalizeProjectOverride<K extends WorkbenchSettingKey>(
  key: K,
  value: unknown,
): WorkbenchProjectSettingOverride<K> {
  const candidate = isRecord(value) ? value : {};
  const enabled = candidate.enabled === true;
  const defaultValue = createDefaultProjectWorkbenchSettings()[key].value;

  switch (key) {
    case "theme":
      return { enabled, value: normalizeTheme(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "editorFontFamily":
      return { enabled, value: normalizeEditorFontFamily(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "fileOpenBehavior":
      return {
        enabled,
        value: normalizeFileOpenBehavior(candidate.value ?? defaultValue),
      } as WorkbenchProjectSettingOverride<K>;
    case "selectedProjectPinPlacement":
      return {
        enabled,
        value: normalizeSelectedProjectPinPlacement(candidate.value ?? defaultValue),
      } as WorkbenchProjectSettingOverride<K>;
    case "editorFontSize":
      return { enabled, value: clampEditorFontSize(candidate.value) } as WorkbenchProjectSettingOverride<K>;
    case "editorSpellCheck":
    case "composerSpellCheck":
    case "showUnopenableFiles":
    case "threadCodeBlockWrap":
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
    fileOpenBehavior: "workbench-or-vscode",
    selectedProjectPinPlacement: "pinned-section",
    showUnopenableFiles: false,
    theme: "default",
    threadCodeBlockWrap: false,
  };
}

export function createDefaultProjectWorkbenchSettings(): WorkbenchProjectSettings {
  const globalDefaults = createDefaultGlobalWorkbenchSettings();
  return {
    composerSpellCheck: { enabled: false, value: globalDefaults.composerSpellCheck },
    editorFontFamily: { enabled: false, value: globalDefaults.editorFontFamily },
    editorFontSize: { enabled: false, value: globalDefaults.editorFontSize },
    editorSpellCheck: { enabled: false, value: globalDefaults.editorSpellCheck },
    fileOpenBehavior: { enabled: false, value: globalDefaults.fileOpenBehavior },
    selectedProjectPinPlacement: { enabled: false, value: globalDefaults.selectedProjectPinPlacement },
    showUnopenableFiles: { enabled: false, value: globalDefaults.showUnopenableFiles },
    theme: { enabled: false, value: globalDefaults.theme },
    threadCodeBlockWrap: { enabled: false, value: globalDefaults.threadCodeBlockWrap },
  };
}

export function createDefaultWorkbenchProjectSidebarPreferences(): WorkbenchProjectSidebarPreferences {
  return {
    browseSessionsOpen: true,
    explorerOpen: true,
    pinnedFolderIds: [],
    pinnedStatusCountsExpanded: true,
    pinnedThreadsOpen: true,
    projectStatusCountsExpanded: true,
    projectsOpen: false,
    projectTimeGroupCount: 1,
    reloadNecessaryOpen: true,
    settledThreadItemLimit: 50,
    settledThreadsOpen: false,
    sidebarCollapsed: false,
    threadFolderIds: [],
    threadsOpen: true,
  };
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
  return {
    composerSpellCheck: normalizeProjectOverride("composerSpellCheck", candidate.composerSpellCheck),
    editorFontFamily: normalizeProjectOverride("editorFontFamily", candidate.editorFontFamily),
    editorFontSize: normalizeProjectOverride("editorFontSize", candidate.editorFontSize),
    editorSpellCheck: normalizeProjectOverride("editorSpellCheck", candidate.editorSpellCheck),
    fileOpenBehavior: normalizeProjectOverride("fileOpenBehavior", candidate.fileOpenBehavior),
    selectedProjectPinPlacement: normalizeProjectOverride("selectedProjectPinPlacement", candidate.selectedProjectPinPlacement),
    showUnopenableFiles: normalizeProjectOverride("showUnopenableFiles", candidate.showUnopenableFiles),
    theme: normalizeProjectOverride("theme", candidate.theme),
    threadCodeBlockWrap: normalizeProjectOverride("threadCodeBlockWrap", candidate.threadCodeBlockWrap),
  } satisfies WorkbenchProjectSettings;
}

export async function writeProjectWorkbenchSetting<K extends WorkbenchSettingKey>(
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
      (preferences as Record<string, boolean | number | readonly string[]>)[record.preference.key] = record.preference.value;
    }
  }
  preferences.pinnedFolderIds = records.flatMap((record) => (
    record.kind === "sidebarFolder"
    && record.daemonRegistrationId === daemonRegistrationId
    && record.projectId === projectId
    && record.scope === "pinned"
      ? [record.folderId]
      : []
  ));
  preferences.threadFolderIds = records.flatMap((record) => (
    record.kind === "sidebarFolder"
    && record.daemonRegistrationId === daemonRegistrationId
    && record.projectId === projectId
    && record.scope === "thread"
      ? [record.folderId]
      : []
  ));
  return preferences;
}

type WorkbenchProjectSidebarScalarKey = Exclude<
  keyof WorkbenchProjectSidebarPreferences,
  "pinnedFolderIds" | "threadFolderIds"
>;

export async function writeWorkbenchProjectSidebarPreference(
  controller: WorkbenchClientStateController,
  projectId: string,
  key: WorkbenchProjectSidebarScalarKey,
  value: WorkbenchProjectSidebarPreferences[WorkbenchProjectSidebarScalarKey],
) {
  await controller.put({
    daemonRegistrationId: controller.daemonRegistrationId,
    kind: "sidebarPreference",
    preference: { key, value } as never,
    projectId,
  });
}

export async function setWorkbenchProjectSidebarFolderOpen(
  controller: WorkbenchClientStateController,
  projectId: string,
  scope: "pinned" | "thread",
  folderId: string,
  open: boolean,
) {
  const identity = {
    daemonRegistrationId: controller.daemonRegistrationId,
    folderId,
    kind: "sidebarFolder" as const,
    projectId,
    scope,
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
    fileOpenBehavior: projectSettings.fileOpenBehavior.enabled ? projectSettings.fileOpenBehavior.value : globalSettings.fileOpenBehavior,
    selectedProjectPinPlacement: projectSettings.selectedProjectPinPlacement.enabled
      ? projectSettings.selectedProjectPinPlacement.value
      : globalSettings.selectedProjectPinPlacement,
    showUnopenableFiles: projectSettings.showUnopenableFiles.enabled ? projectSettings.showUnopenableFiles.value : globalSettings.showUnopenableFiles,
    theme: projectSettings.theme.enabled ? projectSettings.theme.value : globalSettings.theme,
    threadCodeBlockWrap: projectSettings.threadCodeBlockWrap.enabled ? projectSettings.threadCodeBlockWrap.value : globalSettings.threadCodeBlockWrap,
  };
}
