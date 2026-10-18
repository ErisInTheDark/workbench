/*
 * Exports:
 * - default ThreadAddressedFeedback: the feedback a completed thread addressed, as reference pills with a hold-to-confirm delete of the stored reports.
 */
"use client";

import { useContext, useState } from "react";

import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import PrimaryButton from "../../ui/PrimaryButton";
import { deleteFeedbackReports } from "../stats/workspaces/feedback-report-mutations";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import { BinIcon } from "../workbench-icons";
import ComposerReferencePills from "./ComposerReferencePills";

export default function ThreadAddressedFeedback ({ feedback, onDeleted }: {
  feedback: readonly WorkbenchThreadAddressedFeedback[];
  /** The reports are gone from their machines; the thread forgets them. */
  onDeleted: () => Promise<void>;
}) {
  const workspace = useContext(WorkbenchWorkspaceContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!feedback.length) return null;
  const remove = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteFeedbackReports(workspace, feedback);
      await onDeleted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to delete the addressed feedback.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 py-2" data-thread-addressed-feedback="true">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <ComposerReferencePills className="min-w-0" references={feedback} />
        <PrimaryButton
          className="!shrink-0"
          shape="compact"
          disabled={busy || !workspace}
          holdToConfirmMs={500}
          onClick={() => void remove()}
          pendingHalo={busy}
          tone="danger"
        >
          <BinIcon className="mr-1.5" size={14} />
          Delete
        </PrimaryButton>
      </div>
      {error ? <p className="m-0 mt-1.5 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
