/*
 * Exports:
 * - default retryWorktreeIndexing: rerun a Git staging step while files change under it mid-read, then fail with a plain cause.
 * - WORKTREE_INDEXING_RETRY_DELAYS_MS: waits between staging attempts.
 */
import { setTimeout as delay } from "node:timers/promises";

export const WORKTREE_INDEXING_RETRY_DELAYS_MS = [50, 150, 400] as const;

/** Git stats a file, then reads it; a concurrent truncate-and-rewrite makes the read come up short or fail. */
const INDEXING_RACE_PATTERNS = [
  /short read while indexing ([^\r\n]+)/u,
  /unable to index file '([^'\r\n]+)'/u,
];

function errorText(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`;
}

/** The path a Git staging failure names when a file changed while Git indexed it, else null. */
function readWorktreeIndexingRace(error: unknown) {
  const text = errorText(error);
  for (const pattern of INDEXING_RACE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

type Wait = (milliseconds: number, signal?: AbortSignal) => Promise<unknown>;

const realWait: Wait = async (milliseconds, signal) => await delay(milliseconds, undefined, signal ? { signal } : {});

/** A failed `git add` rolls back its index lock, so rerunning it against the same index is safe. */
export default async function retryWorktreeIndexing<T>(
  work: () => Promise<T>,
  { signal, wait = realWait }: { signal?: AbortSignal | undefined; wait?: Wait } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const racedPath = signal?.aborted ? null : readWorktreeIndexingRace(error);
      if (!racedPath) throw error;
      const nextDelay = WORKTREE_INDEXING_RETRY_DELAYS_MS[attempt];
      if (nextDelay === undefined) {
        throw new Error(
          `Worktree files kept changing while Workbench indexed them (${racedPath}). Another writer was mid-write; Git storage is intact. Retry once writes settle.`,
          { cause: error },
        );
      }
      await wait(nextDelay, signal);
    }
  }
}
