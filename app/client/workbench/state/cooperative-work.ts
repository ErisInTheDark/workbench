/*
 * Exports:
 * - CooperativeWorkBudget: browser work-slice budget that yields after the current slice expires. Keywords: scheduler, yield, background.
 * - CooperativeWorkBudgetOptions: optional slice timing for cooperative browser work. Keywords: scheduler, timing, budget.
 * - cooperativeYield: yield browser control until every other queued task has run (background priority). Keywords: scheduler, browser, yield.
 * - createCooperativeWorkBudget: create a reusable elapsed-time work budget. Keywords: scheduler, yield, slices.
 */

export interface CooperativeWorkBudget {
  shouldYield(): boolean;
  yieldIfNeeded(): Promise<void>;
}

export interface CooperativeWorkBudgetOptions {
  sliceMs?: number;
}

interface BrowserScheduler {
  postTask?: (callback: () => void, options: { priority: "background" }) => Promise<void>;
}

const DEFAULT_COOPERATIVE_WORK_SLICE_MS = 20;

function getNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * Resumes at background priority, after every other queued task. `scheduler.yield()` resumes ahead of normal tasks
 * instead, so a long rebuild yielding through it still holds socket messages (a transcript frame) until it finishes.
 */
export async function cooperativeYield() {
  const scheduler = (globalThis as { scheduler?: BrowserScheduler }).scheduler;
  if (scheduler?.postTask) {
    await scheduler.postTask(() => {}, { priority: "background" });
    return;
  }

  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

export function createCooperativeWorkBudget({
  sliceMs = DEFAULT_COOPERATIVE_WORK_SLICE_MS,
}: CooperativeWorkBudgetOptions = {}): CooperativeWorkBudget {
  let deadline = getNow() + sliceMs;

  return {
    shouldYield() {
      return getNow() >= deadline;
    },
    async yieldIfNeeded() {
      if (getNow() < deadline) {
        return;
      }

      await cooperativeYield();
      deadline = getNow() + sliceMs;
    },
  };
}
