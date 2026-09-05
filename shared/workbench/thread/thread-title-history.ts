/*
 * Keywords: thread, title, history, deduplication, recency.
 * Exports:
 * - WorkbenchThreadTitleHistoryEntrySchema/WorkbenchThreadTitleHistoryEntry: one title's last observed use.
 * - recordThreadTitle: retain distinct titles when the current title changes.
 * - dismissThreadTitle: remove a previous title without removing the current title.
 * - previousThreadTitles: project four previous titles in last-use order.
 */
import { z } from "zod";

export const WorkbenchThreadTitleHistoryEntrySchema = z.object({
  title: z.string().min(1),
  usedAt: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadTitleHistoryEntry = z.infer<typeof WorkbenchThreadTitleHistoryEntrySchema>;

export function recordThreadTitle(history: readonly WorkbenchThreadTitleHistoryEntry[], currentTitle: string, title: string, now: number): WorkbenchThreadTitleHistoryEntry[] {
  if (!title) return [...history];
  const titles = new Map<string, WorkbenchThreadTitleHistoryEntry>();
  for (const entry of history) {
    if (!titles.has(entry.title) || titles.get(entry.title)!.usedAt < entry.usedAt) titles.set(entry.title, entry);
  }
  if (currentTitle && !titles.has(currentTitle)) titles.set(currentTitle, { title: currentTitle, usedAt: now });
  if (title !== currentTitle || !titles.has(title)) titles.set(title, { title, usedAt: now });
  return [...titles.values()].sort((left, right) => (
    right.usedAt - left.usedAt
    || Number(right.title === title) - Number(left.title === title)
    || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0)
  ));
}

export function dismissThreadTitle(history: readonly WorkbenchThreadTitleHistoryEntry[], currentTitle: string, title: string): WorkbenchThreadTitleHistoryEntry[] {
  return title === currentTitle ? [...history] : history.filter((entry) => entry.title !== title);
}

export function previousThreadTitles(history: readonly WorkbenchThreadTitleHistoryEntry[], currentTitle: string): WorkbenchThreadTitleHistoryEntry[] {
  return history.filter((entry) => entry.title !== currentTitle)
    .sort((left, right) => right.usedAt - left.usedAt || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0))
    .slice(0, 4);
}
