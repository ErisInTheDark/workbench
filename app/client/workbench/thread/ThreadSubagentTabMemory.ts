/*
 * Exports:
 * - default ThreadSubagentTabMemory: each root thread's subagent tab order and settled-tab reveal, kept by the shell so
 *   they outlive the thread surface remounting on every tab switch.
 * - ThreadSubagentTabMemoryContext: the shell's instance; null outside the shell.
 */
import { createContext } from "react";

import type { SubagentTabOrder } from "./thread-subagents";

interface SubagentTabState {
  order: SubagentTabOrder | null;
  settledVisible: boolean;
}

const EMPTY: SubagentTabState = { order: null, settledVisible: false };

export default class ThreadSubagentTabMemory {
  readonly #states = new Map<string, SubagentTabState>();

  read(rootThreadId: string): SubagentTabState {
    return this.#states.get(rootThreadId) ?? EMPTY;
  }

  write(rootThreadId: string, patch: Partial<SubagentTabState>) {
    this.#states.set(rootThreadId, { ...this.read(rootThreadId), ...patch });
  }
}

export const ThreadSubagentTabMemoryContext = createContext<ThreadSubagentTabMemory | null>(null);
