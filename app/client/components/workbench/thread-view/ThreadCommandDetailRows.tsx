/*
 * Exports:
 * - default ThreadCommandDetailRows: render the shared matcher detail rows.
 */
"use client";
import type { ThreadCommandDetailRow, ThreadCommandDetailTarget } from "../../../workbench/thread/thread-command-matchers";
import { CheckIcon, ClockIcon, PlayIcon, WarningIcon } from "../workbench-icons";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import ThreadUserImage from "./ThreadUserImage";
import { truncateThreadText } from "./thread-view-formatters";
import { ThreadCommandSummary } from "./thread-view-primitives";

const THREAD_DETAIL_INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.88em] leading-[1.6] text-text";

function formatThreadDetailUrlLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname}${parsedUrl.search}`.replace(/\/$/, "");
    return truncateThreadText(`${parsedUrl.host}${path || ""}`, 96);
  } catch { return truncateThreadText(url, 96); }
}

function ThreadCommandDetailTargetView({ target }: { target: ThreadCommandDetailTarget }) {
  if (target.kind === "url") return (
    <a className="min-w-0 break-all text-accent underline-offset-3 hover:underline focus-visible:underline focus-visible:outline-none"
      href={target.text} rel="noreferrer" target="_blank" title={target.text}>{formatThreadDetailUrlLabel(target.text)}</a>
  );
  if (target.kind === "code") return (
    <code className={`${THREAD_DETAIL_INLINE_CODE_CLASS} inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom`} title={target.text}>{target.text}</code>
  );
  return <span className="min-w-0 break-words font-medium text-text">{target.text}</span>;
}

function ThreadCommandDetailMeta({ row }: { row: ThreadCommandDetailRow }) {
  const hasDuration = typeof row.durationMs === "number";
  const hasDetailText = Boolean(row.detailText?.trim());
  if (!hasDuration && !hasDetailText) return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-x-1.5 text-[0.78em] text-fg/muted">
      {hasDuration ? <ThreadDurationText durationMs={row.durationMs ?? null} /> : null}
      {hasDuration && hasDetailText ? <span aria-hidden="true">·</span> : null}
      {hasDetailText ? <span className="inline-flex min-w-0 max-w-full items-baseline gap-x-1">
        {row.detailLabel ? <span>{row.detailLabel}:</span> : null}
        <span className={`min-w-0 max-w-[36rem] truncate ${row.detailKind === "error" ? "text-danger" : "text-fg/muted"}`} title={row.detailText ?? undefined}>{row.detailText}</span>
      </span> : null}
    </span>
  );
}

function ThreadStructuredCommandDetailRow({ hideSharedContext, projectFilePaths, projectId, row }: {
  hideSharedContext: boolean; projectFilePaths?: readonly string[]; projectId?: string | null; row: ThreadCommandDetailRow;
}) {
  if (!row.label && !row.target) return <ThreadCommandSummary display={{
    claimedBy: "command-detail-row", omitFromDisplay: false, ongoingSummaryParts: row.summaryParts,
    ongoingSummaryText: "", shell: null, showShell: false, summaryKind: "matched",
    summaryParts: row.summaryParts, summaryText: "",
    summaryStats: {
      deletedPaths: 0, gitCheckpointCreates: 0, gitCheckpointDiffs: 0, gitCheckpointRestores: 0,
      gitDiffChecks: 0, gitStatusChecks: 0, listedFiles: 0, otherCommands: 0, pathChecks: 0,
      readFiles: 0, searchedFiles: 0, skillLoads: 0, typescriptBuilds: 0, typescriptValidations: 0, webRequests: 0,
    },
  }} projectFilePaths={projectFilePaths} projectId={projectId} />;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
      {row.label ? <span className="shrink-0 text-fg/muted">{row.label}</span> : null}
      {row.target ? <ThreadCommandDetailTargetView target={row.target} /> : null}
      {row.contextText && !hideSharedContext ? <span className="min-w-0 text-fg/muted">in <span className="font-medium text-text">{row.contextText}</span></span> : null}
      <ThreadCommandDetailMeta row={row} />
    </span>
  );
}

function shouldRenderFramedDetailTarget(row: ThreadCommandDetailRow) {
  return row.label === "Evaluate" && row.target?.kind === "code";
}

function ThreadCommandDetailResultBlock({ row }: { row: ThreadCommandDetailRow }) {
  if (!shouldRenderFramedDetailTarget(row)) return null;
  const output = row.detailKind === "result" && row.detailText?.trim() ? row.detailText : undefined;
  return <div className="max-w-[46rem] pl-6 pt-1">
    <ThreadCodeDisplay header={<ThreadCommandHeader command={row.target?.text ?? ""} surface="framed" />}
      output={output} preview previewHeight="10rem" variant="plain" />
  </div>;
}

function ThreadCommandDetailImageBlock({ row }: { row: ThreadCommandDetailRow }) {
  const imageUrls = [...(row.imageUrl ? [row.imageUrl] : []), ...(row.imageUrls ?? [])]
    .filter((imageUrl, index, values) => imageUrl && values.indexOf(imageUrl) === index);
  if (!imageUrls.length) return null;
  return <div className="max-w-[28rem] space-y-2 pl-6 pt-1">
    {imageUrls.map((imageUrl, index) => <ThreadUserImage alt={`${row.label ?? "Browse"} screenshot`}
      className="max-w-[28rem]" key={`${row.id}:image:${index}:${imageUrl}`} src={imageUrl} />)}
  </div>;
}

function getDetailRowSummary(row: ThreadCommandDetailRow): ThreadCommandDetailRow {
  const shouldHideCompletedWaitTarget = row.label === "Wait" && row.durationMs !== null;
  const shouldHideFramedTarget = shouldRenderFramedDetailTarget(row);
  if (!shouldHideCompletedWaitTarget && !shouldHideFramedTarget) return row;
  return {
    ...row,
    detailKind: shouldHideFramedTarget && row.detailKind === "result" ? undefined : row.detailKind,
    detailLabel: shouldHideFramedTarget && row.detailKind === "result" ? null : row.detailLabel,
    detailText: shouldHideFramedTarget && row.detailKind === "result" ? null : row.detailText,
    target: shouldHideCompletedWaitTarget || shouldHideFramedTarget ? null : row.target,
  };
}

export default function ThreadCommandDetailRows({ rows, projectFilePaths, projectId }: {
  rows: ThreadCommandDetailRow[]; projectFilePaths?: readonly string[]; projectId?: string | null;
}) {
  if (!rows.length) return null;
  const contexts = Array.from(new Set(rows.map(row => row.contextText?.trim()).filter(Boolean)));
  const hideSharedContext = contexts.length === 1 && rows.length > 1;
  return <div className="space-y-0.5">
    {rows.map(row => {
      const summary = <ThreadStructuredCommandDetailRow hideSharedContext={hideSharedContext} projectFilePaths={projectFilePaths} projectId={projectId} row={getDetailRowSummary(row)} />;
      const hasExpandableContent = shouldRenderFramedDetailTarget(row) || Boolean(row.imageUrl || row.imageUrls?.length);
      return <ThreadMeasuredContent key={row.id}><div className="space-y-1">
        {hasExpandableContent ? <ThreadDisclosure className="py-1" contentClassName="space-y-1"
          leading={renderCommandDetailStateIcon(row)} leadingClassName={getCommandDetailStateMarkerClassName(row)}
          leadingLabel={getCommandDetailStateLabel(row)} summary={summary} summaryClassName="text-[0.9em] leading-[1.55]">
          <ThreadCommandDetailResultBlock row={row} /><ThreadCommandDetailImageBlock row={row} />
        </ThreadDisclosure> : <ThreadDisclosureStaticRow className="py-1" summary={summary} summaryClassName="text-[0.9em] leading-[1.55]" />}
      </div></ThreadMeasuredContent>;
    })}
  </div>;
}

function renderCommandDetailStateIcon(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued": return <ClockIcon size={16} />;
    case "inProgress": return <PlayIcon size={14} />;
    case "completed": return <CheckIcon size={16} />;
    case "failed": return <WarningIcon size={16} />;
    default: return null;
  }
}

function getCommandDetailStateMarkerClassName(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued": return "text-fg/muted opacity-60";
    case "inProgress": return "text-accent";
    case "completed": return "text-fg/muted";
    case "failed": return "text-danger";
    default: return undefined;
  }
}

function getCommandDetailStateLabel(row: ThreadCommandDetailRow) {
  switch (row.state) {
    case "queued": return "Queued";
    case "inProgress": return "In progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    default: return undefined;
  }
}
