/*
 * Exports:
 * - buildWorkbenchApprovalPresentation: render one approval subject, and any reviewer verdict, as the shared approval questionnaire
 *   request; file writes and machine claims carry every path as structured context.
 */
import type { WorkbenchApprovalReviewContext, WorkbenchUserInputOption, WorkbenchUserInputRequest } from "workbench-shared/types";
import type { WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import { buildWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-questionnaire-request";

const CLAIMS_FALLBACK_REASON = "Claim machine files for editing through a Git arc.";

function detail(label: string, value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? `${label}\n${normalized}` : null;
}

const count = (paths: readonly string[], noun: string) => `${paths.length} ${noun}${paths.length === 1 ? "" : "s"}`;

export function buildWorkbenchApprovalPresentation(input: {
  id: string;
  subject: WorkbenchApprovalSubject;
  allowSession: boolean;
  rememberOptions?: readonly WorkbenchUserInputOption[];
  summary?: string;
  review?: WorkbenchApprovalReviewContext;
}): WorkbenchUserInputRequest {
  const { subject, review } = input;
  const common = { id: input.id, allowSession: input.allowSession, rememberOptions: input.rememberOptions, summary: input.summary };
  const reviewed = review ? { review } : {};
  switch (subject.kind) {
    case "command": {
      const command = subject.command.trim();
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "command",
        ...(command || review ? {
          approval: {
            ...(command ? { command: {
              command, commandActions: subject.commandActions, cwd: subject.cwd.trim(),
              justification: subject.justification ?? "",
              ...(subject.networkTarget ? { networkTarget: subject.networkTarget } : {}),
            } } : {}),
            ...reviewed,
          },
        } : {}),
        details: command ? [] : [
          detail("Working directory", subject.cwd),
          detail("Reason", subject.justification),
          detail("Parsed actions", subject.commandActions.map(action => action.command.trim()).filter(Boolean).join("\n")),
          detail("Network target", subject.networkTarget),
        ],
        prompt: "Should the agent run this command?",
        title: "Approve command execution",
      });
    }
    case "fileChange":
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "file change",
        ...(review ? { approval: reviewed } : {}),
        details: [detail("Reason", subject.reason), detail("Grant root", subject.grantRoot)],
        prompt: "Should the agent write these file changes?",
        title: "Approve file changes",
      });
    case "permissions":
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "permission request",
        ...(review ? { approval: reviewed } : {}),
        details: [
          detail("Working directory", subject.cwd),
          detail("Reason", subject.reason),
          detail("Requested permissions", subject.permissions),
        ],
        prompt: "Should the agent receive these extra permissions?",
        title: "Grant requested permissions",
      });
    case "patch":
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "patch",
        approval: { files: { action: "write", paths: subject.paths }, ...reviewed },
        details: [detail("Grant root", subject.grantRoot)],
        prompt: subject.reason?.trim() || "Should the agent apply this patch?",
        title: `Allow writing ${count(subject.paths, "file")}`,
      });
    case "claims":
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "claim",
        approval: { files: { action: "claim", paths: subject.paths }, ...reviewed },
        details: [],
        prompt: subject.reason?.trim() || CLAIMS_FALLBACK_REASON,
        title: `Allow editing ${count(subject.paths, "machine file")}`,
      });
  }
}
