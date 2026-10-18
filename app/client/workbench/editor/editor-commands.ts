/*
 * Exports:
 * - EditorCommand: every command the markdown toolbar and editor shortcuts run.
 * - EditorKeybind: one key chord; `mod` is Ctrl, or Cmd on Apple platforms.
 * - EDITOR_COMMANDS: label and keybinds of each command.
 * - shownKeybind: the keybind a command's chip shows on this platform (Ctrl+Y redo elsewhere, ⌘⇧Z on Apple).
 * - matchEditorCommand: the command a keydown triggers, if any.
 * - markTagKeybind / matchMarkTagPosition: the Alt+digit chord of a mark tag list position, and the position a keydown selects.
 * - describeKeybind: the key labels of a chord, for keybind chips.
 */

import { MARK_TAG_LIMIT, MarkTag } from "workbench-shared/workbench/settings/mark-tags";

export type EditorCommand =
  | "bold"
  | "italic"
  | "inline-code"
  | "del"
  | "ins"
  | "clear-format"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "unordered-list"
  | "ordered-list"
  | "code-block"
  | "table"
  | "row-above"
  | "row-below"
  | "column-left"
  | "column-right"
  | "delete-row"
  | "delete-column"
  | "comment"
  | "source"
  | "undo"
  | "redo"
  | "save";

export interface EditorKeybind {
  alt?: boolean;
  /** The platform this chord is the one shown on; chords without one show everywhere they come first. */
  shownOn?: "apple" | "other";
  /** Matched against `KeyboardEvent.code`, for keys whose `key` changes with shift or layout. */
  code?: string;
  /** Matched against the lowercased `KeyboardEvent.key`. */
  key?: string;
  mod?: boolean;
  shift?: boolean;
}

interface EditorCommandInfo {
  keybinds: readonly EditorKeybind[];
  label: string;
}

export const EDITOR_COMMANDS: Record<EditorCommand, EditorCommandInfo> = {
  bold: { label: "Bold", keybinds: [{ mod: true, key: "b" }] },
  italic: { label: "Italic", keybinds: [{ mod: true, key: "i" }] },
  "inline-code": { label: "Inline code", keybinds: [{ mod: true, code: "Backquote" }] },
  del: { label: "Mark as deleted", keybinds: [{ mod: true, shift: true, key: "x" }] },
  ins: { label: "Mark as inserted", keybinds: [{ mod: true, shift: true, key: "a" }] },
  "clear-format": { label: "Clear formatting", keybinds: [{ mod: true, code: "Backslash" }] },
  h1: { label: "Heading 1", keybinds: [{ mod: true, alt: true, code: "Digit1" }] },
  h2: { label: "Heading 2", keybinds: [{ mod: true, alt: true, code: "Digit2" }] },
  h3: { label: "Heading 3", keybinds: [{ mod: true, alt: true, code: "Digit3" }] },
  quote: { label: "Quote", keybinds: [{ mod: true, shift: true, code: "Digit9" }] },
  "unordered-list": { label: "Bulleted list", keybinds: [{ mod: true, shift: true, code: "Digit8" }] },
  "ordered-list": { label: "Numbered list", keybinds: [{ mod: true, shift: true, code: "Digit7" }] },
  "code-block": { label: "Code block", keybinds: [{ mod: true, alt: true, code: "KeyC" }] },
  table: { label: "Table", keybinds: [] },
  "row-above": { label: "Insert row above", keybinds: [{ mod: true, alt: true, code: "ArrowUp" }] },
  "row-below": { label: "Insert row below", keybinds: [{ mod: true, alt: true, code: "ArrowDown" }] },
  "column-left": { label: "Insert column left", keybinds: [{ mod: true, alt: true, code: "ArrowLeft" }] },
  "column-right": { label: "Insert column right", keybinds: [{ mod: true, alt: true, code: "ArrowRight" }] },
  "delete-row": { label: "Delete row", keybinds: [] },
  "delete-column": { label: "Delete column", keybinds: [] },
  comment: { label: "Comment", keybinds: [{ mod: true, alt: true, code: "KeyM" }] },
  source: { label: "Markdown source", keybinds: [{ mod: true, key: "e" }] },
  undo: { label: "Undo", keybinds: [{ mod: true, key: "z" }] },
  redo: {
    label: "Redo",
    keybinds: [{ mod: true, shift: true, key: "z", shownOn: "apple" }, { mod: true, key: "y", shownOn: "other" }],
  },
  save: { label: "Save", keybinds: [{ mod: true, key: "s" }] },
};

/** The chord a command's keybind chip shows on this platform: the one marked for it, else the first. */
export function shownKeybind(command: EditorCommand, apple: boolean) {
  const { keybinds } = EDITOR_COMMANDS[command];
  return keybinds.find((keybind) => keybind.shownOn === (apple ? "apple" : "other")) ?? keybinds[0] ?? null;
}

function matchesKeybind(event: KeyboardEvent, keybind: EditorKeybind) {
  if (Boolean(keybind.mod) !== (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(keybind.shift) !== event.shiftKey || Boolean(keybind.alt) !== event.altKey) return false;
  return keybind.code ? event.code === keybind.code : event.key.toLowerCase() === keybind.key;
}

/**
 * The chord applying the mark tag at a list position: Alt with its digit, matched by `code` because Option+digit types
 * a symbol on Apple layouts. Ctrl+digit belongs to the browser's tab switching.
 */
export function markTagKeybind(position: number): EditorKeybind {
  return { alt: true, code: `Digit${MarkTag.keyDigit(position)}` };
}

/** The mark tag list position a keydown selects, if any. */
export function matchMarkTagPosition(event: KeyboardEvent): number | null {
  for (let position = 0; position < MARK_TAG_LIMIT; position += 1) {
    if (matchesKeybind(event, markTagKeybind(position))) return position;
  }
  return null;
}

export function matchEditorCommand(event: KeyboardEvent): EditorCommand | null {
  for (const [command, info] of Object.entries(EDITOR_COMMANDS) as Array<[EditorCommand, EditorCommandInfo]>) {
    if (info.keybinds.some((keybind) => matchesKeybind(event, keybind))) {
      return command;
    }
  }
  return null;
}

const CODE_LABELS: Record<string, string> = {
  ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", Backquote: "`", Backslash: "\\",
};

export function describeKeybind(keybind: EditorKeybind, apple: boolean) {
  const keys: string[] = keybind.mod ? [apple ? "⌘" : "Ctrl"] : [];
  if (keybind.alt) keys.push(apple ? "⌥" : "Alt");
  if (keybind.shift) keys.push(apple ? "⇧" : "Shift");
  const key = keybind.code
    ? CODE_LABELS[keybind.code] ?? keybind.code.replace(/^(Digit|Key)/u, "")
    : keybind.key!.toUpperCase();
  keys.push(key);
  return keys;
}
