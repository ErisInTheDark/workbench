/*
 * Exports:
 * - WorkbenchThreadStatusTone/WorkbenchThreadStatusControlTone: shared visual tone contracts for thread lifecycle presentation. Keywords: thread, status, color, tone.
 * - getNeedsAttentionThreadStatusTone: map attention urgency to amber or purple. Keywords: thread, attention, snooze.
 * - getWorkbenchThreadStatusClassName/getWorkbenchThreadStatusControlClassName: own shared text and context-control color classes. Keywords: thread, status, color, Tailwind.
 */

export type WorkbenchThreadStatusTone = "completed" | "needs-attention" | "needs-attention-active" | "stopped" | "waiting" | "working";
export type WorkbenchThreadStatusControlTone = Exclude<WorkbenchThreadStatusTone, "waiting" | "working">;

export function getNeedsAttentionThreadStatusTone(highPriority: boolean): "needs-attention" | "needs-attention-active" {
  return highPriority ? "needs-attention-active" : "needs-attention";
}

export function getWorkbenchThreadStatusClassName(tone: WorkbenchThreadStatusTone) {
  if (tone === "working") return "text-sky-600 dark:text-sky-300";
  if (tone === "waiting" || tone === "stopped") return "text-muted";
  if (tone === "needs-attention-active") return "text-amber-600 dark:text-amber-300";
  if (tone === "needs-attention") return "text-violet-600 dark:text-violet-300";
  return "text-emerald-600 dark:text-emerald-300";
}

export function getWorkbenchThreadStatusControlClassName(tone: WorkbenchThreadStatusControlTone | undefined) {
  if (tone === "needs-attention-active") return "!text-amber-600 hover:!text-amber-600 focus-visible:!text-amber-600 dark:!text-amber-300 dark:hover:!text-amber-300 dark:focus-visible:!text-amber-300";
  if (tone === "needs-attention") return "!text-violet-600 hover:!text-violet-600 focus-visible:!text-violet-600 dark:!text-violet-300 dark:hover:!text-violet-300 dark:focus-visible:!text-violet-300";
  if (tone === "completed") return "!text-emerald-600 hover:!text-emerald-600 focus-visible:!text-emerald-600 dark:!text-emerald-300 dark:hover:!text-emerald-300 dark:focus-visible:!text-emerald-300";
  if (tone === "stopped") return "!text-muted hover:!text-muted focus-visible:!text-muted";
  return "";
}
