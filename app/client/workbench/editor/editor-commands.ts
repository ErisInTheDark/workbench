/*
 * Exports:
 * - EditorCommand: every command the markdown toolbar and editor shortcuts run.
 * - EditorKeybind: one key chord; `mod` is Ctrl, or Cmd on Apple platforms.
 * - EDITOR_COMMANDS: label and keybinds of each command; the first keybind is the one shown.
 * - matchEditorCommand: the command a keydown triggers, if any.
 * - describeKeybind: the key labels of a chord, for keybind chips.
 */

export type EditorCommand =
  | "bold"
  | "italic"
  | "inline-code"
  | "del"
  | "ins"
  | "h1"
  | "h2"
  | "h3"
  | "quote"
  | "unordered-list"
  | "ordered-list"
  | "comment"
  | "undo"
  | "redo";

export interface EditorKeybind {
  alt?: boolean;
  /** Matched against `KeyboardEvent.code`, for keys whose `key` changes with shift or layout. */
  code?: string;
  /** Matched against the lowercased `KeyboardEvent.key`. */
  key?: string;
  mod: true;
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
  h1: { label: "Heading 1", keybinds: [{ mod: true, alt: true, code: "Digit1" }] },
  h2: { label: "Heading 2", keybinds: [{ mod: true, alt: true, code: "Digit2" }] },
  h3: { label: "Heading 3", keybinds: [{ mod: true, alt: true, code: "Digit3" }] },
  quote: { label: "Quote", keybinds: [{ mod: true, shift: true, code: "Digit9" }] },
  "unordered-list": { label: "Bulleted list", keybinds: [{ mod: true, shift: true, code: "Digit8" }] },
  "ordered-list": { label: "Numbered list", keybinds: [{ mod: true, shift: true, code: "Digit7" }] },
  comment: { label: "Comment", keybinds: [{ mod: true, alt: true, code: "KeyM" }] },
  undo: { label: "Undo", keybinds: [{ mod: true, key: "z" }] },
  redo: { label: "Redo", keybinds: [{ mod: true, shift: true, key: "z" }, { mod: true, key: "y" }] },
};

function matchesKeybind(event: KeyboardEvent, keybind: EditorKeybind) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (Boolean(keybind.shift) !== event.shiftKey || Boolean(keybind.alt) !== event.altKey) return false;
  return keybind.code ? event.code === keybind.code : event.key.toLowerCase() === keybind.key;
}

export function matchEditorCommand(event: KeyboardEvent): EditorCommand | null {
  for (const [command, info] of Object.entries(EDITOR_COMMANDS) as Array<[EditorCommand, EditorCommandInfo]>) {
    if (info.keybinds.some((keybind) => matchesKeybind(event, keybind))) {
      return command;
    }
  }
  return null;
}

const CODE_LABELS: Record<string, string> = { Backquote: "`" };

export function describeKeybind(keybind: EditorKeybind, apple: boolean) {
  const keys: string[] = [apple ? "⌘" : "Ctrl"];
  if (keybind.alt) keys.push(apple ? "⌥" : "Alt");
  if (keybind.shift) keys.push(apple ? "⇧" : "Shift");
  const key = keybind.code
    ? CODE_LABELS[keybind.code] ?? keybind.code.replace(/^(Digit|Key)/u, "")
    : keybind.key!.toUpperCase();
  keys.push(key);
  return keys;
}
