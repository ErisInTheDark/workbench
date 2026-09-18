/*
 * Exports:
 * - CopyFeedbackNode: minimal accessible control surface.
 * - CopyFeedbackController: register controls and copy with disposable feedback.
 * - createCopyFeedbackController: own clipboard feedback and its reset timers.
 */
import { writeTextToClipboard } from "./clipboard";

export interface CopyFeedbackNode {
  setAttribute(name: string, value: string): void;
  title: string;
}

export interface CopyFeedbackController {
  copy(button: CopyFeedbackNode, text: string): Promise<boolean>;
  register(button: CopyFeedbackNode): () => void;
}

export function createCopyFeedbackController({
  clearScheduled = clearTimeout,
  schedule = setTimeout,
  writeText = writeTextToClipboard,
  attribute = "data-copy-state",
  label = "Copy",
  copiedLabel = "Copied",
}: {
  clearScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  writeText?: (text: string) => Promise<boolean>;
  attribute?: string;
  label?: string;
  copiedLabel?: string;
} = {}): CopyFeedbackController {
  const controls = new Map<CopyFeedbackNode, { timer?: ReturnType<typeof setTimeout>; attempt: number }>();
  const show = (button: CopyFeedbackNode, state: "idle" | "copied" | "failed") => {
    const text = state === "idle" ? label : state === "copied" ? copiedLabel : "Copy failed";
    button.setAttribute("aria-label", text);
    button.setAttribute(attribute, state);
    button.title = text;
  };
  const clear = (entry: { timer?: ReturnType<typeof setTimeout> }) => {
    if (entry.timer !== undefined) clearScheduled(entry.timer);
    delete entry.timer;
  };
  return {
    async copy(button, text) {
      const entry = controls.get(button);
      if (!entry || !text.trim()) return false;
      const attempt = ++entry.attempt;
      const copied = await writeText(text);
      if (controls.get(button) !== entry || entry.attempt !== attempt) return false;
      clear(entry);
      show(button, copied ? "copied" : "failed");
      entry.timer = schedule(() => {
        delete entry.timer;
        if (controls.get(button) === entry) show(button, "idle");
      }, 1_600);
      return copied;
    },
    register(button) {
      const previous = controls.get(button);
      if (previous) clear(previous);
      const entry: { timer?: ReturnType<typeof setTimeout>; attempt: number } = { attempt: 0 };
      controls.set(button, entry);
      show(button, "idle");
      return () => {
        if (controls.get(button) !== entry) return;
        clear(entry);
        controls.delete(button);
      };
    },
  };
}
