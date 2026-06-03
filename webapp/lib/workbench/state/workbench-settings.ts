/*
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE: editor zoom defaults and bounds. Keywords: settings, editor, zoom.
 * - WorkbenchTheme, WorkbenchEditorFontFamily, WorkbenchFileOpenBehavior, WorkbenchSettingKey: setting value contracts for Workbench preferences. Keywords: settings, theme, editor, composer, file open, thread code.
 * - WorkbenchGlobalSettings, WorkbenchProjectSettings, WorkbenchResolvedSettings: stored and resolved settings shapes. Keywords: settings, global, project override.
 * - WORKBENCH_SETTING_DEFINITIONS: labels and option metadata for settings UI rendering. Keywords: settings, registry, UI.
 * - createDefaultGlobalWorkbenchSettings: create agentic global defaults. Keywords: settings, defaults, agentic.
 * - readGlobalWorkbenchSettings/writeGlobalWorkbenchSettings: persist global Workbench preferences in localStorage. Keywords: settings, localStorage, global.
 * - readProjectWorkbenchSettings/writeProjectWorkbenchSettings: persist explicit project override slots in localStorage. Keywords: settings, localStorage, project.
 * - resolveWorkbenchSettings: merge project overrides over global settings. Keywords: settings, inheritance, overrides.
 * - readStoredEditorFontSize/writeStoredEditorFontSize/readStoredTheme/writeStoredTheme: compatibility helpers for older callers. Keywords: settings, legacy, bridge.
 */

export const DEFAULT_EDITOR_FONT_SIZE = 1.08;
export const MIN_EDITOR_FONT_SIZE = 0.84;
export const MAX_EDITOR_FONT_SIZE = 1.72;

const GLOBAL_SETTINGS_STORAGE_KEY = "workbench:settings:global";
const PROJECT_SETTINGS_STORAGE_KEY = "workbench:settings:projects";
const LEGACY_FONT_SIZE_STORAGE_KEY = "workbench:font-size";
const LEGACY_THEME_STORAGE_KEY = "workbench:theme";

export type WorkbenchTheme = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamily = "sans" | "serif" | "mono";
export type WorkbenchFileOpenBehavior = "workbench" | "workbench-or-vscode" | "vscode";
export type WorkbenchSettingKey =
  | "theme"
  | "editorFontFamily"
  | "editorSpellCheck"
  | "composerSpellCheck"
  | "editorFontSize"
  | "fileOpenBehavior"
  | "showUnopenableFiles"
  | "threadCodeBlockWrap";

export interface WorkbenchGlobalSettings {
  composerSpellCheck: boolean;
  editorFontFamily: WorkbenchEditorFontFamily;
  editorFontSize: number;
  editorSpellCheck: boolean;
  fileOpenBehavior: WorkbenchFileOpenBehavior;
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

export type WorkbenchSettingDefinition<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
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

function readJsonStorageValue(key: string) {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}

function writeJsonStorageValue(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures and keep in-memory settings usable.
  }
}

function readLegacyTheme() {
  try {
    return normalizeTheme(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY));
  } catch {
    return "default";
  }
}

function readLegacyEditorFontSize() {
  try {
    return clampEditorFontSize(window.localStorage.getItem(LEGACY_FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

function normalizeGlobalWorkbenchSettings(value: unknown): WorkbenchGlobalSettings {
  const candidate = isRecord(value) ? value : {};
  return {
    composerSpellCheck: typeof candidate.composerSpellCheck === "boolean" ? candidate.composerSpellCheck : false,
    editorFontFamily: normalizeEditorFontFamily(candidate.editorFontFamily),
    editorFontSize: clampEditorFontSize(candidate.editorFontSize ?? readLegacyEditorFontSize()),
    editorSpellCheck: typeof candidate.editorSpellCheck === "boolean" ? candidate.editorSpellCheck : false,
    fileOpenBehavior: normalizeFileOpenBehavior(candidate.fileOpenBehavior),
    showUnopenableFiles: typeof candidate.showUnopenableFiles === "boolean" ? candidate.showUnopenableFiles : false,
    theme: normalizeTheme(candidate.theme ?? readLegacyTheme()),
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
      return { enabled, value: normalizeFileOpenBehavior(candidate.value) } as WorkbenchProjectSettingOverride<K>;
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
    showUnopenableFiles: { enabled: false, value: globalDefaults.showUnopenableFiles },
    theme: { enabled: false, value: globalDefaults.theme },
    threadCodeBlockWrap: { enabled: false, value: globalDefaults.threadCodeBlockWrap },
  };
}

export function readGlobalWorkbenchSettings() {
  return normalizeGlobalWorkbenchSettings(readJsonStorageValue(GLOBAL_SETTINGS_STORAGE_KEY));
}

export function writeGlobalWorkbenchSettings(settings: WorkbenchGlobalSettings) {
  const normalizedSettings = normalizeGlobalWorkbenchSettings(settings);
  writeJsonStorageValue(GLOBAL_SETTINGS_STORAGE_KEY, normalizedSettings);
  try {
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, normalizedSettings.theme);
    window.localStorage.setItem(LEGACY_FONT_SIZE_STORAGE_KEY, String(normalizedSettings.editorFontSize));
  } catch {
    // Legacy mirrors are best-effort only.
  }
}

export function readProjectWorkbenchSettings(projectId: string) {
  const allProjectSettings = readJsonStorageValue(PROJECT_SETTINGS_STORAGE_KEY);
  const projectSettings = isRecord(allProjectSettings) ? allProjectSettings[projectId] : null;
  const candidate = isRecord(projectSettings) ? projectSettings : {};
  return {
    composerSpellCheck: normalizeProjectOverride("composerSpellCheck", candidate.composerSpellCheck),
    editorFontFamily: normalizeProjectOverride("editorFontFamily", candidate.editorFontFamily),
    editorFontSize: normalizeProjectOverride("editorFontSize", candidate.editorFontSize),
    editorSpellCheck: normalizeProjectOverride("editorSpellCheck", candidate.editorSpellCheck),
    fileOpenBehavior: normalizeProjectOverride("fileOpenBehavior", candidate.fileOpenBehavior),
    showUnopenableFiles: normalizeProjectOverride("showUnopenableFiles", candidate.showUnopenableFiles),
    theme: normalizeProjectOverride("theme", candidate.theme),
    threadCodeBlockWrap: normalizeProjectOverride("threadCodeBlockWrap", candidate.threadCodeBlockWrap),
  } satisfies WorkbenchProjectSettings;
}

export function writeProjectWorkbenchSettings(projectId: string, settings: WorkbenchProjectSettings) {
  const allProjectSettings = readJsonStorageValue(PROJECT_SETTINGS_STORAGE_KEY);
  const nextProjectSettings = isRecord(allProjectSettings) ? { ...allProjectSettings } : {};
  nextProjectSettings[projectId] = {
    composerSpellCheck: normalizeProjectOverride("composerSpellCheck", settings.composerSpellCheck),
    editorFontFamily: normalizeProjectOverride("editorFontFamily", settings.editorFontFamily),
    editorFontSize: normalizeProjectOverride("editorFontSize", settings.editorFontSize),
    editorSpellCheck: normalizeProjectOverride("editorSpellCheck", settings.editorSpellCheck),
    fileOpenBehavior: normalizeProjectOverride("fileOpenBehavior", settings.fileOpenBehavior),
    showUnopenableFiles: normalizeProjectOverride("showUnopenableFiles", settings.showUnopenableFiles),
    theme: normalizeProjectOverride("theme", settings.theme),
    threadCodeBlockWrap: normalizeProjectOverride("threadCodeBlockWrap", settings.threadCodeBlockWrap),
  };
  writeJsonStorageValue(PROJECT_SETTINGS_STORAGE_KEY, nextProjectSettings);
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
    showUnopenableFiles: projectSettings.showUnopenableFiles.enabled ? projectSettings.showUnopenableFiles.value : globalSettings.showUnopenableFiles,
    theme: projectSettings.theme.enabled ? projectSettings.theme.value : globalSettings.theme,
    threadCodeBlockWrap: projectSettings.threadCodeBlockWrap.enabled ? projectSettings.threadCodeBlockWrap.value : globalSettings.threadCodeBlockWrap,
  };
}

export function readStoredEditorFontSize() {
  return readGlobalWorkbenchSettings().editorFontSize;
}

export function writeStoredEditorFontSize(fontSize: number) {
  writeGlobalWorkbenchSettings({
    ...readGlobalWorkbenchSettings(),
    editorFontSize: clampEditorFontSize(fontSize),
  });
}

export function readStoredTheme() {
  return readGlobalWorkbenchSettings().theme;
}

export function writeStoredTheme(theme: WorkbenchTheme) {
  writeGlobalWorkbenchSettings({
    ...readGlobalWorkbenchSettings(),
    theme,
  });
}
