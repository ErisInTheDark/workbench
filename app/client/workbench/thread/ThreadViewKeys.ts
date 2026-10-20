/*
 * Exports:
 * - default ThreadViewKeys: which view instance shows each thread, so a launched draft keeps its view (and launch handoff)
 *   as its route moves on to the new thread or a fresh draft.
 * - ThreadViewKeysContext: the shell's instance; null outside the shell.
 */
import { createContext } from "react";

export default class ThreadViewKeys {
  readonly #keys = new Map<string, string>();

  /** An unknown thread is its own view. */
  keyFor(threadId: string) {
    return this.#keys.get(threadId) ?? threadId;
  }

  /** `to` now shows in the view `from` showed in. */
  carry(from: string, to: string) {
    this.#keys.set(to, this.keyFor(from));
  }

  forget(threadId: string) {
    this.#keys.delete(threadId);
  }
}

export const ThreadViewKeysContext = createContext<ThreadViewKeys | null>(null);
