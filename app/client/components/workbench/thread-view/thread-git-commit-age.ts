/*
 * Exports:
 * - CommitAgeBucket: calendar age of an accepted commit relative to now.
 * - getCommitAgeBucket: place one commit time into its local-calendar bucket.
 * - groupCommitsByAge: split accepted commits into titled age groups, oldest group first, empty groups dropped.
 */

export type CommitAgeBucket = "older" | "month" | "week" | "yesterday" | "today";

const bucketOrder: readonly CommitAgeBucket[] = ["older", "month", "week", "yesterday", "today"];

const bucketTitles: Record<CommitAgeBucket, string> = {
  older: "Older commits",
  month: "Commits this month",
  week: "Commits this week",
  yesterday: "Commits yesterday",
  today: "Commits earlier",
};

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Unknown times are older than every recorded one: they predate commit times being recorded. */
export function getCommitAgeBucket(committedAt: string | undefined, now: Date): CommitAgeBucket {
  const time = committedAt ? Date.parse(committedAt) : Number.NaN;
  if (!Number.isFinite(time)) return "older";
  const today = startOfDay(now);
  if (time >= today.getTime()) return "today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (time >= yesterday.getTime()) return "yesterday";
  // Weeks start on Monday.
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  if (time >= weekStart.getTime()) return "week";
  if (time >= new Date(today.getFullYear(), today.getMonth(), 1).getTime()) return "month";
  return "older";
}

export function groupCommitsByAge<Entry>(
  entries: readonly Entry[],
  committedAt: (entry: Entry) => string | undefined,
  now: Date,
) {
  const groups = Map.groupBy(entries, entry => getCommitAgeBucket(committedAt(entry), now));
  return bucketOrder.flatMap(bucket => {
    const grouped = groups.get(bucket);
    return grouped ? [{ bucket, entries: grouped, title: bucketTitles[bucket] }] : [];
  });
}
