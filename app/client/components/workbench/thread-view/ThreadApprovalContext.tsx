/*
 * Exports:
 * - ThreadApprovalCommand: an approval's command, drawn through the contextual project's command display, with its reason and network target.
 * - default ThreadApprovalContext: every path a file write or machine claim approval grants, in a bounded scroll box with its count,
 *   then why auto-review left the request for the person.
 */
"use client";

import type { WorkbenchApprovalFilesContext, WorkbenchApprovalReviewContext, WorkbenchUserInputRequest } from "workbench-shared/types";
import { getThreadCommandDisplay, isBrowseCommandMatcherClaim } from "../../../workbench/thread/thread-command-matchers";
import { useProject } from "../use-projects";
import { ShieldAlertIcon } from "../workbench-icons";
import ThreadClaimedFileList from "./ThreadClaimedFileList";
import ThreadCommandDisplay from "./ThreadCommandDisplay";

export function ThreadApprovalCommand ({ request }: { request: WorkbenchUserInputRequest }) {
  const project = useProject.contextual();
  const commandContext = request.approval?.command ?? null;
  const input = commandContext
    ? { command: commandContext.command, commandActions: commandContext.commandActions, cwd: commandContext.cwd }
    : null;
  const display = input ? project?.commandDisplay(input) ?? getThreadCommandDisplay(input) : null;

  if (!display || !commandContext) {
    return null;
  }

  return (
    <>
      <ThreadCommandDisplay command={commandContext.command} display={display} browse={isBrowseCommandMatcherClaim(display.claimedBy)} previewHeight="auto" />
      {commandContext.justification ? <p className="m-0 whitespace-pre-wrap break-words text-[0.92em] leading-[1.65] text-text">{commandContext.justification}</p> : null}
      {commandContext.networkTarget ? <p className="m-0 break-all text-[0.84em] text-fg/muted">Network target: {commandContext.networkTarget}</p> : null}
    </>
  );
}

function ApprovalFiles ({ files }: { files: WorkbenchApprovalFilesContext }) {
  if (!files.paths.length) return null;
  const claim = files.action === "claim";
  return (
    <div className="rounded-[0.9rem] bg-recess">
      <div className="px-3 pt-2 text-[0.8em] text-fg/muted">{files.paths.length} {files.paths.length === 1 ? "path" : "paths"}</div>
      <div className="max-h-[13rem] overflow-y-auto px-3 scrollbar-hover-reveal">
        <ThreadClaimedFileList fullPaths inset={false} label={claim ? "Claim" : "Write"} marker={claim ? "planned" : "claimed"} paths={files.paths} />
      </div>
    </div>
  );
}

function ApprovalReview ({ review }: { review: WorkbenchApprovalReviewContext }) {
  const manual = review.outcome === "manual";
  const explanation = manual ? review.rationale : review.error;
  return (
    <div className="flex items-start gap-2 rounded-[0.9rem] bg-danger/8 px-3 py-2.5">
      <ShieldAlertIcon className="mt-0.5 shrink-0 text-danger" size={16} />
      <div className="min-w-0 text-[0.88em] leading-[1.55]">
        <span className="font-semibold text-danger">{manual ? "Auto-review sent this to you" : "Auto-review failed"}</span>
        {manual ? <span className="text-fg/muted"> · {review.assessment}</span> : null}
        {explanation ? <p className="m-0 mt-0.5 whitespace-pre-wrap break-words text-text">{explanation}</p> : null}
      </div>
    </div>
  );
}

export default function ThreadApprovalContext ({ request }: { request: WorkbenchUserInputRequest }) {
  const { files, review } = request.approval ?? {};
  if (!files && !review) return null;
  return (
    <div className="mt-3 space-y-3">
      {files ? <ApprovalFiles files={files} /> : null}
      {review ? <ApprovalReview review={review} /> : null}
    </div>
  );
}
