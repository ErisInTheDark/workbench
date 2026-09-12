/*
 * Keywords: stats, readiness, progress, failures, layout stability.
 * Exports:
 * - default WorkbenchStatsStatus: reserve status space and disclose details without shifting statistics.
 */
import type { WorkbenchStatsImportProgress, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";

export default function WorkbenchStatsStatus({ ready, loading, retained, error, progress, failures, legacy }: {
  ready: boolean;
  loading: boolean;
  retained: boolean;
  error: string;
  progress: WorkbenchStatsImportProgress | null;
  failures: WorkbenchStatsResponse["failures"];
  legacy: boolean;
}) {
  const failedImports = progress?.recentFailures ?? [];
  const issues = failedImports.length + failures.length + (error ? 1 : 0);
  const status = !ready ? "Connecting..."
    : legacy ? "Detailed statistics need a server reload."
      : loading ? retained ? "Updating - showing previous selection." : "Loading usage..."
        : error ? "Statistics could not be refreshed." : "";
  const hasDetails = Boolean(progress || issues || legacy);
  return (
    <div className="relative flex h-6 min-w-0 items-center gap-3 text-[0.72rem] leading-6 text-fg/muted">
      <p aria-live="polite" className={`m-0 min-w-0 flex-1 truncate ${error ? "text-danger" : ""}`}>{status || "\u00a0"}</p>
      <details className="group order-first shrink-0" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
        <summary className={`
          w-fit max-w-full cursor-pointer truncate rounded-md px-1 hover:bg-surface-hover
          ${hasDetails ? "" : "invisible"}
          ${issues ? "text-danger" : ""}
        `}>
          {progress?.state === "running" ? `Importing history ${progress.percent.toFixed(0)}%` : "History details"}
          {issues ? ` · ${issues} issues` : ""}
        </summary>
        <div className="absolute inset-x-0 top-full z-20 max-h-72 overflow-auto rounded-lg bg-bg p-4 shadow-float sm:max-w-xl">
          {legacy ? <p className="m-0">This server supports legacy statistics only. Token selection and category costs become available after a server reload.</p> : null}
          {error ? <p className="m-0 break-words text-danger">{error}</p> : null}
          {progress ? (
            <p className="m-0">
              Usage {progress.usage.processed}/{progress.usage.total} · claims {progress.claims.processed}/{progress.claims.total}
              {progress.unsupportedClaimCheckpoints ? ` · ${progress.unsupportedClaimCheckpoints} older claim checkpoints unsupported` : ""}
            </p>
          ) : null}
          {failedImports.map((failure, index) => <p className="m-0 break-words text-danger" key={`import:${index}`}>{failure.source} · {failure.subject} · {failure.message}</p>)}
          {failures.map((failure, index) => <p className="m-0 break-words text-danger" key={`capture:${index}`}>{failure.harness ? `${failure.harness} · ` : ""}{failure.message}</p>)}
        </div>
      </details>
    </div>
  );
}
