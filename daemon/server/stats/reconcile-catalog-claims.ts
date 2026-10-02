/*
 * Exports:
 * - reconcileCatalogClaims: reconcile live claim snapshots for every catalogued project that is still a Git checkout.
 */

interface CatalogProject { id: string; rootPath: string; roots: readonly { rootPath: string }[] }

/**
 * The catalogue keeps projects whose folder was deleted or whose `.git` broke; they hold no arc claims to
 * reconcile, so they are skipped rather than reported on every pass. Failures in real checkouts still report.
 */
export async function reconcileCatalogClaims({ isCheckout, projects, reconcile, reportFailure, signal }: {
  /** Whether a folder is a usable Git checkout; it may throw for unexpected filesystem failures. */
  isCheckout: (rootPath: string) => Promise<boolean>;
  projects: readonly CatalogProject[];
  reconcile: (rootPath: string) => Promise<void>;
  reportFailure: (projectId: string, error: unknown) => void;
  signal: AbortSignal;
}) {
  for (const project of projects) {
    if (signal.aborted) return;
    try {
      const checkouts = await Promise.all(project.roots.map(({ rootPath }) => isCheckout(rootPath)));
      if (!checkouts.some(Boolean)) continue;
      await reconcile(project.rootPath);
    } catch (error) {
      reportFailure(project.id, error);
    }
  }
}
