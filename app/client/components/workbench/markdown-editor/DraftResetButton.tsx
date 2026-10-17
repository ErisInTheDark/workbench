/*
 * Exports:
 * - default DraftResetButton: a reset icon button that opens into a hold-to-confirm danger button, deleting the draft
 *   first and then restoring the file from git, and folds back once the pointer and focus have been away for a second.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import IconButton from "../../ui/IconButton";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { BinIcon } from "../workbench-icons";

const HOLD_MS = 1000;
const FOLD_DELAY_MS = 1000;

type ResetAction = "delete-draft" | "restore-from-git";

const ACTION_LABELS: Record<ResetAction, string> = {
  "delete-draft": "Delete draft",
  "restore-from-git": "Restore from git",
};

export default function DraftResetButton({
  hasDraft,
  onDeleteDraft,
  onRestoreFromGit,
  savedDiffersFromHead,
}: {
  hasDraft: boolean;
  onDeleteDraft: () => Promise<void>;
  onRestoreFromGit: () => Promise<void>;
  savedDiffersFromHead: boolean;
}) {
  const action: ResetAction | null = hasDraft ? "delete-draft" : savedDiffersFromHead ? "restore-from-git" : null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const engaged = useRef({ focus: false, hover: false });
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFold = () => {
    if (foldTimer.current !== null) clearTimeout(foldTimer.current);
    foldTimer.current = null;
  };
  const engage = (kind: "focus" | "hover", value: boolean) => {
    engaged.current[kind] = value;
    cancelFold();
    if (!engaged.current.focus && !engaged.current.hover) foldTimer.current = setTimeout(() => setOpen(false), FOLD_DELAY_MS);
  };
  useEffect(() => cancelFold, []);

  const run = async () => {
    if (!action || busy) return;
    setBusy(true);
    try {
      await (action === "delete-draft" ? onDeleteDraft() : onRestoreFromGit());
    } finally {
      setBusy(false);
    }
  };

  const expanded = open && action !== null;
  return (
    <span
      className="inline-flex"
      onPointerEnter={() => engage("hover", true)}
      onPointerLeave={() => engage("hover", false)}
      onFocus={() => engage("focus", true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) engage("focus", false);
      }}
    >
      {expanded ? (
        <PrimaryButton
          autoFocus
          shape="compact"
          tone="danger"
          holdToConfirmMs={HOLD_MS}
          disabled={busy}
          className="h-8"
          onClick={() => { void run(); }}
        >
          <span className="inline-flex items-center gap-1.5">
            <BinIcon size={14} />
            <span className="max-w-32 overflow-hidden whitespace-nowrap transition-[max-width] duration-200 ease-out starting:max-w-0">
              {ACTION_LABELS[action]}
            </span>
          </span>
        </PrimaryButton>
      ) : (
        <Tooltip placement="bottom" delayMs={350} content={action ? ACTION_LABELS[action] : "Matches git"}>
          <IconButton
            label={action ? ACTION_LABELS[action] : "Reset file"}
            title=""
            size="small"
            display="hover-border"
            disabled={action === null}
            onClick={() => setOpen(true)}
          >
            <BinIcon size={16} />
          </IconButton>
        </Tooltip>
      )}
    </span>
  );
}
