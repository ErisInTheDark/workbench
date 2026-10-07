/*
 * Exports:
 * - APPROVAL_MODE_OPTIONS: display label and glyph for each approval mode.
 * - default WorkbenchApprovalModeMenu: daemon-project composer control choosing approvals on, skip approvals, or auto-approve, with a way into reviewer setup.
 */
"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { WorkbenchApprovalMode } from "workbench-shared/types";
import ApprovalReviewSettingsController, { selectedReviewerReady } from "../../workbench/ApprovalReviewSettingsController";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import { SettingsIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionIcon, type IconProps } from "./workbench-icons";

export const APPROVAL_MODE_OPTIONS: Record<WorkbenchApprovalMode, { label: string; description: string; icon: (size: NonNullable<IconProps["size"]>) => ReactNode }> = {
  approvals: {
    label: "Approvals on",
    description: "Ask before each command runs outside the sandbox.",
    icon: size => <ShieldQuestionIcon className="shrink-0" size={size} />,
  },
  skip: {
    label: "Skip approvals",
    description: "Run outside-sandbox commands without asking.",
    icon: size => <ShieldAlertIcon className="shrink-0 text-danger" size={size} />,
  },
  auto: {
    label: "Auto-approve",
    description: "A reviewer approves safe commands and asks you about the rest.",
    icon: size => <ShieldCheckIcon className="shrink-0 text-accent" size={size} />,
  },
};

const ORDER: readonly WorkbenchApprovalMode[] = ["approvals", "skip", "auto"];

/** The selected reviewer's readiness on the view's daemon, re-read whenever the menu opens. */
function useReviewerReady() {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(() => new ApprovalReviewSettingsController({
    read: () => daemon.approvalReview.read(),
    update: update => daemon.approvalReview.update(update),
  }), [daemon]);
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { ready: selectedReviewerReady(state.settings), refresh: () => { void controller.refresh(); } };
}

export default function WorkbenchApprovalModeMenu({
  mode,
  disabled = false,
  onSelect,
  onOpenSettings,
}: {
  mode: WorkbenchApprovalMode;
  disabled?: boolean;
  onSelect: (mode: WorkbenchApprovalMode) => void;
  onOpenSettings: () => void;
}) {
  const reviewer = useReviewerReady();
  const current = APPROVAL_MODE_OPTIONS[mode];
  const needsSetup = mode === "auto" && reviewer.ready === false;
  return (
    <span className="inline-flex min-w-0 items-center">
      <WorkbenchPressDragMenu
        label="Outside-sandbox approvals"
        disabled={disabled}
        onOpen={reviewer.refresh}
        triggerClassName="text-text"
        items={ORDER.map(id => ({
          id,
          checked: id === mode,
          content: (
            <span className="flex min-w-0 items-start gap-2 text-left">
              <span className="mt-0.5">{APPROVAL_MODE_OPTIONS[id].icon(16)}</span>
              <span className="flex min-w-0 flex-col">
                <span>{APPROVAL_MODE_OPTIONS[id].label}</span>
                <span className="text-[0.72em] text-fg/muted">{APPROVAL_MODE_OPTIONS[id].description}</span>
              </span>
            </span>
          ),
        }))}
        onSelect={id => {
          const next = ORDER.find(candidate => candidate === id);
          if (next && next !== mode) onSelect(next);
        }}
      >
        {current.icon(16)}
        <span className="min-w-0 truncate">{current.label}</span>
      </WorkbenchPressDragMenu>
      {mode === "auto" ? (
        <button
          type="button"
          aria-label={needsSetup ? "Set up auto-approve" : "Auto-approve settings"}
          title={needsSetup ? "Choose a reviewer to auto-approve" : "Auto-approve settings"}
          className={`
            relative isolate inline-flex shrink-0 items-center gap-1.5 bg-transparent px-2 py-2 transition cursor-pointer
            before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-['']
            hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft
            ${needsSetup ? "text-danger" : "text-fg/muted hover:text-text"}
          `}
          onClick={onOpenSettings}
        >
          <SettingsIcon size={14} />
          {needsSetup ? <span>Set up</span> : null}
        </button>
      ) : null}
    </span>
  );
}
