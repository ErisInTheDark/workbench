/*
 * Exports:
 * - APPROVAL_MODE_OPTIONS: display label, tone and glyph for each approval mode.
 * - useApprovalReviewerReady: selected auto-approve reviewer readiness on the view's daemon, with a refresh.
 * - ApprovalReviewerSetupNotice: composer alert linking to reviewer settings when auto-approve cannot work.
 * - default WorkbenchApprovalModeMenu: daemon-project composer control choosing approvals on, skip approvals, or auto-approve.
 */
"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { WorkbenchApprovalMode } from "workbench-shared/types";
import ApprovalReviewSettingsController, { selectedReviewerReady } from "../../workbench/ApprovalReviewSettingsController";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionIcon, type IconProps } from "./workbench-icons";

type IconSize = NonNullable<IconProps["size"]>;

export const APPROVAL_MODE_OPTIONS: Record<WorkbenchApprovalMode, { label: string; tone: string; icon: (size: IconSize) => ReactNode }> = {
  approvals: { label: "Approvals on", tone: "text-text", icon: size => <ShieldQuestionIcon className="shrink-0" size={size} /> },
  skip: { label: "Skip approvals", tone: "text-approval-skip", icon: size => <ShieldAlertIcon className="shrink-0" size={size} /> },
  auto: { label: "Auto-approve", tone: "text-approval-auto", icon: size => <ShieldCheckIcon className="shrink-0" size={size} /> },
};

const ORDER: readonly WorkbenchApprovalMode[] = ["approvals", "skip", "auto"];

function ModeLabel({ mode, size }: { mode: WorkbenchApprovalMode; size: IconSize }) {
  const option = APPROVAL_MODE_OPTIONS[mode];
  return <span className={`flex min-w-0 items-center gap-2 ${option.tone}`}>
    {option.icon(size)}
    <span className="min-w-0 truncate">{option.label}</span>
  </span>;
}

/** The selected reviewer's readiness on the view's daemon; null while unknown or when disabled. */
export function useApprovalReviewerReady(enabled: boolean) {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(() => enabled ? new ApprovalReviewSettingsController({
    read: () => daemon.approvalReview.read(),
    update: update => daemon.approvalReview.update(update),
  }) : null, [daemon, enabled]);
  useEffect(() => {
    if (!controller) return;
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? noSnapshot, controller?.getSnapshot ?? noSnapshot);
  return { ready: selectedReviewerReady(state.settings), refresh: () => { void controller?.refresh(); } };
}

const idleSnapshot = { settings: null, busy: false, error: "" };
const noSnapshot = () => idleSnapshot;
const noSubscription = () => () => {};

/** Composer alert for auto-approve without a usable reviewer, linking to its settings. */
export function ApprovalReviewerSetupNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  return <p role="alert" className="m-0 min-w-0 truncate px-1 text-[0.78em] text-danger">
    No auto-approve reviewer.{" "}
    <button type="button" className="cursor-pointer bg-transparent p-0 font-medium text-danger underline underline-offset-2"
      onClick={onOpenSettings}>Set up</button>
  </p>;
}

export default function WorkbenchApprovalModeMenu({
  mode,
  disabled = false,
  onOpen,
  onSelect,
}: {
  mode: WorkbenchApprovalMode;
  disabled?: boolean;
  onOpen?: () => void;
  onSelect: (mode: WorkbenchApprovalMode) => void;
}) {
  return (
    <WorkbenchPressDragMenu
      label={`Unsandboxed shell usage: ${APPROVAL_MODE_OPTIONS[mode].label}`}
      heading="Unsandboxed shell usage"
      disabled={disabled}
      onOpen={onOpen}
      items={ORDER.map(id => ({ id, checked: id === mode, content: <ModeLabel mode={id} size={16} /> }))}
      onSelect={id => {
        const next = ORDER.find(candidate => candidate === id);
        if (next && next !== mode) onSelect(next);
      }}
    >
      <ModeLabel mode={mode} size={18} />
    </WorkbenchPressDragMenu>
  );
}
