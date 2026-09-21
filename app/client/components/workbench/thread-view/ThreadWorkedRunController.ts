/*
 * Exports:
 * - default ThreadWorkedRunController: remember worked-run collapse state across scroll-windowing remounts.
 */

import type { WorkedRunState } from "./thread-worked-run";

export default class ThreadWorkedRunController {
  readonly #states = new Map<string, WorkedRunState>();

  read(identity: string): WorkedRunState | undefined {
    return this.#states.get(identity);
  }

  write(identity: string, state: WorkedRunState) {
    this.#states.set(identity, state);
  }
}
