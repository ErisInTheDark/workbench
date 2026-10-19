/*
 * Exports:
 * - WorkbenchTheme: available themes.
 * - WorkbenchThreadAnimationStyle: how streamed thread text, items and blocks animate in.
 * - WorkbenchEditorFontFamily: editor font choices.
 * - WorkbenchViewableFileOpenDestination: where a file kind with a Workbench view opens.
 * - WorkbenchOtherFileOpenDestination: where files without a Workbench view open.
 * - WorkbenchFileOpenSettingKey: per-file-kind open destination settings.
 * - WorkbenchFileOpenPolicy: every per-file-kind open destination.
 * - WORKBENCH_FILE_OPEN_SETTING_KEYS: file kind to its open destination setting.
 * - WorkbenchSettingKey: configurable setting identities.
 * - WorkbenchGlobalOnlySettingKey/WorkbenchProjectSettingKey/isWorkbenchGlobalOnlySettingKey: which settings projects may override.
 * - WorkbenchGlobalSettings: global preference values.
 * - USER_NAME_MAX_LENGTH: longest stored user name.
 * - WorkbenchSettingDefinition: setting control metadata.
 * - WORKBENCH_SETTING_DEFINITIONS: shared settings controls and search metadata.
 */
import type { GitPeerSyncMode } from "../git/git-peer-contracts";
import type { WorkbenchFileKind } from "../project/tree-utils";
import type { MarkTag } from "./mark-tags";

export type WorkbenchTheme = "default" | "magical-girl" | "winter";
export type WorkbenchThreadAnimationStyle = "soft" | "calm" | "ink" | "pop" | "glide" | "glow" | "typewriter";
export type WorkbenchEditorFontFamily = "sans" | "serif" | "mono";
export type WorkbenchViewableFileOpenDestination = "workbench" | "vscode";
export type WorkbenchOtherFileOpenDestination = "vscode" | "none";
export type WorkbenchFileOpenSettingKey = "openMarkdownFilesWith" | "openSvgFilesWith" | "openOtherFilesWith";
export type WorkbenchSettingKey =
  | "theme" | "editorFontFamily" | "editorSpellCheck" | "composerSpellCheck"
  | "editorFontSize" | WorkbenchFileOpenSettingKey | "gitPeerSyncMode"
  | "showUnopenableFiles" | "threadAnimationStyle" | "threadCodeBlockWrap" | "threadCodeDetails" | "userName" | "markTags";

/** Personal preferences that projects never override. */
export type WorkbenchGlobalOnlySettingKey = "threadAnimationStyle";
export type WorkbenchProjectSettingKey = Exclude<WorkbenchSettingKey, WorkbenchGlobalOnlySettingKey>;

export function isWorkbenchGlobalOnlySettingKey(key: WorkbenchSettingKey): key is WorkbenchGlobalOnlySettingKey {
  return key === "threadAnimationStyle";
}

export const WORKBENCH_FILE_OPEN_SETTING_KEYS = {
  markdown: "openMarkdownFilesWith",
  svg: "openSvgFilesWith",
  other: "openOtherFilesWith",
} as const satisfies Record<WorkbenchFileKind | "other", WorkbenchFileOpenSettingKey>;

export interface WorkbenchGlobalSettings {
  composerSpellCheck: boolean;
  editorFontFamily: WorkbenchEditorFontFamily;
  editorFontSize: number;
  editorSpellCheck: boolean;
  openMarkdownFilesWith: WorkbenchViewableFileOpenDestination;
  openOtherFilesWith: WorkbenchOtherFileOpenDestination;
  openSvgFilesWith: WorkbenchViewableFileOpenDestination;
  gitPeerSyncMode: GitPeerSyncMode;
  /** Suggest-mode tags in keybind order: position 0 is Alt+1, position 9 is Alt+0. */
  markTags: readonly MarkTag[];
  showUnopenableFiles: boolean;
  theme: WorkbenchTheme;
  threadAnimationStyle: WorkbenchThreadAnimationStyle;
  threadCodeBlockWrap: boolean;
  threadCodeDetails: boolean;
  /** Signs new markdown comments; empty leaves them unsigned. */
  userName: string;
}

export const USER_NAME_MAX_LENGTH = 40;

export type WorkbenchFileOpenPolicy = Pick<WorkbenchGlobalSettings, WorkbenchFileOpenSettingKey>;

export type WorkbenchSettingDefinition<K extends WorkbenchSettingKey = WorkbenchSettingKey> = {
  columns?: "one" | "two";
  description: string;
  key: K;
  label: string;
  /** Longest value a text control accepts. */
  maxLength?: number;
  options?: Array<{ description: string; label: string; value: WorkbenchGlobalSettings[K] }>;
  /** Shown by an empty text control. */
  placeholder?: string;
  type: "boolean" | "markTags" | "number" | "select" | "text";
};

export const WORKBENCH_SETTING_DEFINITIONS: { [K in WorkbenchSettingKey]: WorkbenchSettingDefinition<K> } = {
  gitPeerSyncMode: {
    description: "Default for cross-device Pull and Send. Hold Shift to use the other mode for one transfer.",
    key: "gitPeerSyncMode", label: "Cross-device sync", type: "select",
    options: [
      { label: "Merge", value: "merge", description: "Preserve both histories. Divergent work adds a merge commit on the receiving device." },
      { label: "Rebase", value: "rebase", description: "Rebase unpublished incoming work on its owning device, then fast-forward the receiver. Published work is never rewritten." },
    ],
  },
  composerSpellCheck: { description: "Controls spellcheck in thread composers and questionnaire text answers.", key: "composerSpellCheck", label: "Composer spellcheck", type: "boolean" },
  editorFontFamily: {
    description: "Controls the body font used by the rich markdown editor.", key: "editorFontFamily", label: "Markdown editor font", type: "select",
    options: [
      { description: "Agentic default for technical editing.", label: "Sans", value: "sans" },
      { description: "Story-writing style with a literary feel.", label: "Serif", value: "serif" },
      { description: "Code-adjacent and compact.", label: "Mono", value: "mono" },
    ],
  },
  editorFontSize: { description: "Controls editor and thread text scale.", key: "editorFontSize", label: "Text size", type: "number" },
  markTags: {
    description: "Tags that underline words in suggest mode. Each one's number is its Alt shortcut; drag to reorder.",
    key: "markTags", label: "Mark tags", type: "markTags",
  },
  openMarkdownFilesWith: {
    description: "Rich text editor.", key: "openMarkdownFilesWith", label: "Markdown", type: "select",
    options: [
      { description: "Edit as rich text in Workbench.", label: "Workbench", value: "workbench" },
      { description: "Ask the local server to open the file in VS Code.", label: "VS Code", value: "vscode" },
    ],
  },
  openSvgFilesWith: {
    description: "Preview and code editor.", key: "openSvgFilesWith", label: "SVG", type: "select",
    options: [
      { description: "Edit in the Workbench preview and code editor.", label: "Workbench", value: "workbench" },
      { description: "Ask the local server to open the file in VS Code.", label: "VS Code", value: "vscode" },
    ],
  },
  openOtherFilesWith: {
    description: "Files without a Workbench view.", key: "openOtherFilesWith", label: "Other files", type: "select",
    options: [
      { description: "Ask the local server to open the file in VS Code.", label: "VS Code", value: "vscode" },
      { description: "Ignore links to these files.", label: "Ignore", value: "none" },
    ],
  },
  showUnopenableFiles: { description: "Controls whether the project sidebar shows files Workbench cannot open directly.", key: "showUnopenableFiles", label: "Show unsupported files", type: "boolean" },
  threadAnimationStyle: {
    columns: "two", description: "Controls how streamed thread text, new thread items and new blocks animate in.",
    key: "threadAnimationStyle", label: "Thread animation", type: "select",
    options: [
      { description: "Words lift and unblur; blocks open their space first.", label: "Soft rise", value: "soft" },
      { description: "Plain fades with minimal motion.", label: "Calm", value: "calm" },
      { description: "Long soft fades that leave a gradient trailing edge.", label: "Ink", value: "ink" },
      { description: "Words pop in with a tiny overshoot.", label: "Pop", value: "pop" },
      { description: "Words slide in; items wipe in from the top.", label: "Glide", value: "glide" },
      { description: "Fresh words glow in the accent colour, then cool.", label: "Glow", value: "glow" },
      { description: "No fades; a caret rides the end of the text.", label: "Typewriter", value: "typewriter" },
    ],
  },
  threadCodeBlockWrap: { description: "Controls whether thread markdown code blocks wrap long lines instead of using horizontal scrolling.", key: "threadCodeBlockWrap", label: "Wrap thread code blocks", type: "boolean" },
  threadCodeDetails: { description: "Show code-mode source and raw output alongside captured tool calls. Failed executions and calls without captured tool results remain visible.", key: "threadCodeDetails", label: "Show code details", type: "boolean" },
  editorSpellCheck: { description: "Controls browser spellcheck in the rich markdown editor.", key: "editorSpellCheck", label: "Editor spellcheck", type: "boolean" },
  userName: { description: "", key: "userName", label: "Name", maxLength: USER_NAME_MAX_LENGTH, placeholder: "User", type: "text" },
  theme: {
    columns: "two", description: "Controls Workbench colors and font personality.", key: "theme", label: "Theme", type: "select",
    options: [
      { description: "Quiet Workbench colors and fonts.", label: "Default", value: "default" },
      { description: "Pink sparkles with Sour Gummy and Comic Code Light.", label: "Magical girl mode", value: "magical-girl" },
      { description: "Snowy day and night colors with the normal Workbench fonts.", label: "Winter", value: "winter" },
    ],
  },
};
