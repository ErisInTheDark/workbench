/*
 * Exports:
 * - TerminalKeyEvent: one decoded key press, repeat or release.
 * - KITTY_KEYBOARD_QUERY/KITTY_KEYBOARD_PUSH/KITTY_KEYBOARD_POP: progressive-enhancement escape sequences for real key release.
 * - decodeTerminalInput: decode one raw stdin chunk into key events and whether it answered the kitty keyboard query.
 * - HoldOutcome/TerminalKeyHold: hold-to-confirm decisions for one key from press, repeat, release and Escape, with an injected clock.
 */

export type TerminalKeyEvent = { key: string; type: "press" | "repeat" | "release" };

/** Ask whether the terminal speaks the kitty keyboard protocol; supporting terminals answer `CSI ? flags u`. */
export const KITTY_KEYBOARD_QUERY = "\u001b[?u";
/**
 * Push flags 1 (disambiguate) + 2 (report press/repeat/release) + 8 (report all keys as escape codes): without 8,
 * text keys such as `r` still arrive as plain text and never report their release.
 */
export const KITTY_KEYBOARD_PUSH = "\u001b[>11u";
export const KITTY_KEYBOARD_POP = "\u001b[<u";

const KITTY_QUERY_REPLY = /\u001b\[\?\d+u/gu;
// CSI code[:alternates] [; modifiers[:event]] u
const KITTY_KEY = /\u001b\[(\d+)(?::[\d:]*)?(?:;(\d+)?(?::(\d))?)?u/gu;

const KITTY_CTRL = 4;

function kittyKey(code: number, modifiers: number) {
  if (code === 27) return "Escape";
  if (code === 13) return "Enter";
  // With all keys reported as escape codes, Ctrl+C is `c` with the ctrl modifier rather than ETX.
  if (code === 99 && modifiers & KITTY_CTRL) return "\u0003";
  return String.fromCodePoint(code);
}

/**
 * Legacy terminals send each press and each autorepeat as the same plain character, so legacy input only ever yields
 * `press`; a lone ESC byte (nothing following in the same chunk) is the Escape key, while longer escape sequences
 * (arrows, function keys) are ignored. Kitty input carries explicit event types.
 */
export function decodeTerminalInput(chunk: string): { events: TerminalKeyEvent[]; kittySupported: boolean } {
  const kittySupported = KITTY_QUERY_REPLY.test(chunk);
  KITTY_QUERY_REPLY.lastIndex = 0;
  const rest = chunk.replace(KITTY_QUERY_REPLY, "");
  const events: TerminalKeyEvent[] = [];
  if (rest === "\u001b") return { events: [{ key: "Escape", type: "press" }], kittySupported };
  let index = 0;
  for (const match of rest.matchAll(KITTY_KEY)) {
    for (const character of rest.slice(index, match.index)) {
      if (character !== "\u001b") events.push({ key: character, type: "press" });
    }
    const event = match[3] === "3" ? "release" : match[3] === "2" ? "repeat" : "press";
    events.push({ key: kittyKey(Number(match[1]), Number(match[2] ?? 1) - 1), type: event });
    index = match.index + match[0].length;
  }
  const tail = rest.slice(index);
  // Unrecognised escape sequences (arrows, function keys) are not key presses this view handles.
  if (!tail.startsWith("\u001b")) for (const character of tail) events.push({ key: character, type: "press" });
  return { events, kittySupported };
}

export type HoldOutcome = "holding" | "fire" | "cancel";

/** Without key release events, a press with no repeat inside this window was a tap. */
const FIRST_REPEAT_WINDOW_MS = 700;
/** Without key release events, repeats stopping for this many observed intervals means the key was released. */
const RELEASE_GAP_INTERVALS = 2.5;
const MIN_RELEASE_GAP_MS = 80;

/**
 * Decides one key hold. With `releases` (kitty) only a real release ends it; otherwise autorepeat keeps it alive and a
 * repeat gap ends it. Releasing at full progress fires, earlier cancels, and Escape cancels even at full progress.
 */
export class TerminalKeyHold {
  private lastInputAt: number;
  private interval: number | null = null;
  private releasedAt: number | null = null;

  constructor(
    readonly key: string,
    readonly durationMs: number,
    readonly startedAt: number,
    private readonly releases: boolean,
  ) {
    this.lastInputAt = startedAt;
  }

  progress(now: number) {
    const end = this.releasedAt ?? now;
    return Math.min(1, Math.max(0, (end - this.startedAt) / this.durationMs));
  }

  /** Feed one decoded event; returns the hold's outcome after it. */
  accept(event: TerminalKeyEvent, now: number): HoldOutcome {
    if (event.key === "Escape") return "cancel";
    if (event.key !== this.key) return "holding";
    if (event.type === "release") return this.release(now);
    // The first gap is the OS repeat delay; only later gaps measure the repeat rate.
    if (!this.releases && this.lastInputAt !== this.startedAt) {
      const gap = now - this.lastInputAt;
      this.interval = this.interval === null ? gap : Math.min(this.interval, gap);
    }
    this.lastInputAt = now;
    return "holding";
  }

  /** Advance time without input; autorepeat holds end here when repeats stop. */
  tick(now: number): HoldOutcome {
    if (this.releases) return "holding";
    const gap = now - this.lastInputAt;
    const repeated = this.lastInputAt !== this.startedAt;
    if (!repeated) return gap > FIRST_REPEAT_WINDOW_MS ? this.release(this.startedAt) : "holding";
    const limit = Math.max(MIN_RELEASE_GAP_MS, (this.interval ?? MIN_RELEASE_GAP_MS) * RELEASE_GAP_INTERVALS);
    return gap > limit ? this.release(this.lastInputAt + (this.interval ?? 0)) : "holding";
  }

  private release(at: number): HoldOutcome {
    this.releasedAt = at;
    return this.progress(at) >= 1 ? "fire" : "cancel";
  }
}
