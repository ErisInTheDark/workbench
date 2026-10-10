/*
 * Exports:
 * - VisBridge: the `window.wb` object Workbench injects into every vis frame.
 * - sendVisAnswer: send one JSON value to the agent, which reads it with `wb vis read`.
 * - useVisAnswer: send a named answer and remember what was last sent, for "sent" feedback.
 */
import { useState } from "react";

export interface VisBridge {
  /** Delivers `value` (JSON, at most 16 KB) while the user has the vis focused; otherwise it is dropped. */
  send(value: unknown): void;
}

declare global {
  interface Window {
    wb?: VisBridge;
  }
}

export function sendVisAnswer(value: unknown) {
  if (!window.wb) throw new Error("This page is not running inside a Workbench vis.");
  window.wb.send(value);
}

/** Sends `{ name, value }`; `sent` holds the last value sent from this hook. */
export function useVisAnswer<T>(name: string) {
  const [sent, setSent] = useState<{ value: T } | null>(null);
  return {
    sent,
    send(value: T) {
      sendVisAnswer({ name, value });
      setSent({ value });
    },
  };
}
