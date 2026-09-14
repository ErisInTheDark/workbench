/*
 * Exports:
 * - CooperativeWorkBudget: browser work-slice budget that yields after the current slice expires. Keywords: scheduler, yield, background.
 * - CooperativeWorkBudgetOptions: optional slice timing for cooperative browser work. Keywords: scheduler, timing, budget.
 * - cooperativeYield: yield browser control using scheduler.yield when available. Keywords: scheduler, browser, yield.
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
  yield?: () => Promise<void>;
}

const DEFAULT_COOPERATIVE_WORK_SLICE_MS = 20;

function getNow() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export async function cooperativeYield() {
  const scheduler = (globalThis as { scheduler?: BrowserScheduler }).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
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
