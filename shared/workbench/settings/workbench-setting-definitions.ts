/*
 * Exports:
 * - WorkbenchTheme: available themes.
 * - WorkbenchEditorFontFamily: editor font choices.
 * - WorkbenchFileOpenBehavior: file opening policy.
 * - WorkbenchSelectedProjectPinPlacement: selected-project pin location.
 * - WorkbenchSettingKey: configurable setting identities.
 * - WorkbenchGlobalSettings: global preference values.
 * - WorkbenchSettingDefinition: setting control metadata.
 * - WORKBENCH_SETTING_DEFINITIONS: shared settings controls and search metadata.
 */
import type { WorkbenchSelectedProjectPinPlacementValue } from "../../state/workbench-client-state.ts";

export type WorkbenchTheme = "default" | "magical-girl" | "winter";
export type WorkbenchEditorFontFamily = "sans" | "serif" | "mono";
export type WorkbenchFileOpenBehavior = "workbench" | "workbench-or-vscode" | "vscode";
export type WorkbenchSelectedProjectPinPlacement = WorkbenchSelectedProjectPinPlacementValue;
export type WorkbenchSettingKey =
  | "theme" | "editorFontFamily" | "editorSpellCheck" | "composerSpellCheck"
  | "editorFontSize" | "fileOpenBehavior" | "selectedProjectPinPlacement"
  | "showUnopenableFiles" | "threadCodeBlockWrap" | "threadCodeDetails";

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
  threadCodeDetails: boolean;
}

export type WorkbenchSettingDefinition<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
  columns?: "one" | "two";
  description: string;
  key: K;
  label: string;
  options?: Array<{ description: string; label: string; value: WorkbenchGlobalSettings[K] }>;
  type: "boolean" | "number" | "select";
};

export const WORKBENCH_SETTING_DEFINITIONS: { [K in WorkbenchSettingKey]: WorkbenchSettingDefinition<K> } = {
  composerSpellCheck: { description: "Controls spellcheck in thread composers and questionnaire text answers.", key: "composerSpellCheck", label: "Composer spellcheck", type: "boolean" },
  editorFontFamily: {
    description: "Controls the body font used by the rich markdown editor.", key: "editorFontFamily", label: "Editor font", type: "select",
    options: [
      { description: "Agentic default for technical editing.", label: "Sans", value: "sans" },
      { description: "Story-writing style with a literary feel.", label: "Serif", value: "serif" },
      { description: "Code-adjacent and compact.", label: "Mono", value: "mono" },
    ],
  },
  editorFontSize: { description: "Controls editor and thread text scale.", key: "editorFontSize", label: "Text size", type: "number" },
  fileOpenBehavior: {
    description: "Controls whether project file links open in Workbench or VS Code.", key: "fileOpenBehavior", label: "Open files with", type: "select",
    options: [
      { description: "Open supported markdown files in Workbench and ignore unsupported files.", label: "Workbench only", value: "workbench" },
      { description: "Open markdown in Workbench and use VS Code for files Workbench cannot open.", label: "Workbench, then VS Code", value: "workbench-or-vscode" },
      { description: "Always ask the local server to open file links in VS Code.", label: "VS Code", value: "vscode" },
    ],
  },
  selectedProjectPinPlacement: {
    columns: "two", description: "Choose where pinned threads from the selected project appear.", key: "selectedProjectPinPlacement", label: "Selected-project pin placement", type: "select",
    options: [
      { description: "Keep them in the global pinned threads list.", label: "Pinned threads", value: "pinned-section" },
      { description: "A pinned section at the top of the project's threads.", label: "Threads", value: "threads-section" },
    ],
  },
  showUnopenableFiles: { description: "Controls whether the project sidebar shows files Workbench cannot open directly.", key: "showUnopenableFiles", label: "Show unsupported files", type: "boolean" },
  threadCodeBlockWrap: { description: "Controls whether thread markdown code blocks wrap long lines instead of using horizontal scrolling.", key: "threadCodeBlockWrap", label: "Wrap thread code blocks", type: "boolean" },
  threadCodeDetails: { description: "Show code-mode source and raw output alongside captured tool calls. Failed executions and calls without captured tool results remain visible.", key: "threadCodeDetails", label: "Show code details", type: "boolean" },
  editorSpellCheck: { description: "Controls browser spellcheck in the rich markdown editor.", key: "editorSpellCheck", label: "Editor spellcheck", type: "boolean" },
  theme: {
    columns: "two", description: "Controls Workbench colors and font personality.", key: "theme", label: "Theme", type: "select",
    options: [
      { description: "Current quiet Workbench colors and fonts.", label: "Default", value: "default" },
      { description: "Pink sparkles with Sour Gummy and Comic Code Light.", label: "Magical girl mode", value: "magical-girl" },
      { description: "Snowy day and night colors with the normal Workbench fonts.", label: "Winter", value: "winter" },
    ],
  },
};
