/*
 * Exports:
 * - buildWorkbenchApprovalPresentation: render one approval subject as the shared approval questionnaire request.
 * - summarizeApprovalList: bound a list of approval detail values for display.
 */
import type { WorkbenchUserInputOption, WorkbenchUserInputRequest } from "workbench-shared/types";
import type { WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import { buildWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-questionnaire-request";

function truncate(value: string, maxLength = 400) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function detail(label: string, value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? `${label}\n${truncate(normalized)}` : null;
}

export function summarizeApprovalList(values: readonly string[], maxItems = 5) {
  const normalized = values.map(value => value.trim()).filter(Boolean);
  if (!normalized.length) return null;
  const hidden = normalized.length - Math.min(maxItems, normalized.length);
  return `${normalized.slice(0, maxItems).map(value => truncate(value)).join("\n")}${hidden > 0 ? `\n+${hidden} more` : ""}`;
}

export function buildWorkbenchApprovalPresentation(input: {
  id: string;
  subject: WorkbenchApprovalSubject;
  allowSession: boolean;
  rememberOptions?: readonly WorkbenchUserInputOption[];
  summary?: string;
}): WorkbenchUserInputRequest {
  const { subject } = input;
  const common = { id: input.id, allowSession: input.allowSession, rememberOptions: input.rememberOptions, summary: input.summary };
  switch (subject.kind) {
    case "command": {
      const command = subject.command.trim();
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "command",
        ...(command ? {
          approval: { command: {
            command, commandActions: subject.commandActions, cwd: subject.cwd.trim(),
            justification: subject.justification ?? "",
            ...(subject.networkTarget ? { networkTarget: subject.networkTarget } : {}),
          } },
        } : {}),
        details: command ? [] : [
          detail("Working directory", subject.cwd),
          detail("Reason", subject.justification),
          detail("Parsed actions", summarizeApprovalList(subject.commandActions.map(action => action.command))),
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
        details: [detail("Reason", subject.reason), detail("Grant root", subject.grantRoot)],
        prompt: "Should the agent write these file changes?",
        title: "Approve file changes",
      });
    case "permissions":
      return buildWorkbenchApprovalRequest({
        ...common,
        actionLabel: "permission request",
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
        details: [
          detail("Reason", subject.reason),
          detail("Grant root", subject.grantRoot),
          detail("Changed paths", summarizeApprovalList(subject.paths)),
        ],
        prompt: "Should the agent apply this patch?",
        title: "Approve patch application",
      });
  }
}
