"use client";

/*
 * Exports:
 * - default WorkbenchStatsFeedbackSelectionBar: sticky summary of selected feedback with hold-to-delete and address actions.
 */
import type { WorkbenchFeedbackCategory } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import PrimaryButton from "../../../ui/PrimaryButton";
import WorkbenchStatsFeedbackTag from "./WorkbenchStatsFeedbackTag";
import WorkbenchStickyCard from "../../WorkbenchStickyCard";
import Tooltip from "../../../ui/Tooltip";
import { BinIcon, BotIcon } from "../../workbench-icons";

const DELETE_HOLD_MS = 1_000;
// Matches the action buttons on Git arc cards.
const buttonClassName = "!px-3 !py-1.5 !text-[0.76rem]";

export default function WorkbenchStatsFeedbackSelectionBar({ addressBlocked, busy, error, onAddress, onDelete, selection }: {
  /** Why the selection cannot be addressed, or null when it can. */
  addressBlocked: string | null;
  busy: boolean;
  error: string;
  onAddress: () => void;
  onDelete: () => void;
  /** Null when nothing is selected; the card then closes while still showing the last selection. */
  selection: { counts: readonly { category: WorkbenchFeedbackCategory; count: number }[]; total: number } | null;
}) {
  const address = (
    <span className="inline-flex">
      <PrimaryButton className={buttonClassName} disabled={busy || addressBlocked !== null} onClick={onAddress}>
        <BotIcon className="mr-1.5" size={14} />Address
      </PrimaryButton>
    </span>
  );
  return (
    <WorkbenchStickyCard className="sticky bottom-3 z-20 [--hue-chroma:60%]" label="Selected feedback" open={selection !== null}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pl-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[0.82rem] font-semibold text-text">{selection?.total} selected</span>
          {selection?.counts.map(({ category, count }) => <WorkbenchStatsFeedbackTag category={category} count={count} key={category} />)}
        </div>
        <PrimaryButton className={buttonClassName} disabled={busy} holdToConfirmMs={DELETE_HOLD_MS} onClick={onDelete} tone="danger">
          <BinIcon className="mr-1.5" size={14} />Delete
        </PrimaryButton>
        {addressBlocked ? <Tooltip content={addressBlocked} placement="top">{address}</Tooltip> : address}
      </div>
      {error ? <p className="m-0 mt-1.5 pl-1.5 text-[0.74rem] text-danger">{error}</p> : null}
    </WorkbenchStickyCard>
  );
}
