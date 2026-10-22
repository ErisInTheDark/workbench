/*
 * Exports:
 * - default WorkbenchGitObjectHeader: a commit's or stash's message, author, age, sha and committing threads, with its
 *   actions: copy, undo while unpublished, restore and drop. Moves that would strand threads' claims ask again by name.
 */
"use client";
import { useState } from "react";
import type { GitCheckoutOwner, GitObjectDetail, GitRefMutation } from "workbench-shared/workbench/git/git-object-contracts";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { formatLongTimestamp, formatThreadRelativeTimestamp } from "../thread-view/thread-view-formatters";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { CheckIcon, CopyIcon, GitStashIcon, Trash2Icon, Undo2Icon } from "../workbench-icons";
import WorkbenchGitThreadChip from "./WorkbenchGitThreadChip";
import { useWorkingTree } from "./WorkbenchWorkingTreeProvider";

const HOLD_MS = 1_000;

function CopySha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  return <Tooltip content={copied ? "Copied" : sha} placement="top">
    <button type="button" className="inline-flex items-center gap-1 rounded-md px-1 font-mono text-fg/muted hover:bg-accent-soft hover:text-text"
      onClick={() => { void navigator.clipboard.writeText(sha).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
      {sha.slice(0, 7)}{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </button>
  </Tooltip>;
}

export default function WorkbenchGitObjectHeader({ detail, onLeave }: {
  detail: GitObjectDetail;
  /** The object stopped being reviewable here (undone, restored or dropped); show the working tree instead. */
  onLeave(): void;
}) {
  const daemon = useWorkbenchDaemonClient();
  const projectId = useWorkingTree().projectId;
  const [busy, setBusy] = useState<GitRefMutation["action"] | null>(null);
  const [failure, setFailure] = useState("");
  const [disturbs, setDisturbs] = useState<GitCheckoutOwner[] | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const { object } = detail;
  const run = async (mutation: GitRefMutation) => {
    setBusy(mutation.action);
    setFailure("");
    try {
      const result = await daemon.git.mutateRef(mutation);
      if (result.status === "disturbs") { setDisturbs(result.owners); return; }
      if (result.conflicts.length) { setConflicts(result.conflicts); return; }
      onLeave();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };
  const base = { projectId: ProjectIdSchema.parse(projectId) };
  return <header className="space-y-2 pb-4">
    <div className="flex items-start gap-3">
      <h2 className="m-0 min-w-0 flex-1 text-lg font-semibold leading-snug">{detail.subject || <em className="font-normal text-fg/muted">{object.kind === "stash" ? "unnamed stash" : "no message"}</em>}</h2>
      <div className="flex shrink-0 items-center gap-1.5">
        {object.kind === "commit" && !detail.undoBlocked ? <PrimaryButton shape="compact" tone="danger" holdToConfirmMs={HOLD_MS}
          disabled={busy !== null} pendingHalo={busy === "undoCommit"}
          onClick={() => void run({ ...base, action: "undoCommit", sha: object.sha, disturb: false })}>
          <Undo2Icon size={14} className="mr-1" />Undo
        </PrimaryButton> : null}
        {object.kind === "stash" ? <>
          <PrimaryButton shape="compact" disabled={busy !== null} pendingHalo={busy === "restoreStash"}
            onClick={() => void run({ ...base, action: "restoreStash", sha: object.sha })}>
            <GitStashIcon size={14} className="mr-1" />Restore
          </PrimaryButton>
          <Tooltip content="Hold to drop" placement="top">
            <PrimaryButton shape="compact" tone="danger" holdToConfirmMs={HOLD_MS} disabled={busy !== null} pendingHalo={busy === "dropStash"}
              aria-label="Drop stash" onClick={() => void run({ ...base, action: "dropStash", sha: object.sha })}>
              <Trash2Icon size={14} />
            </PrimaryButton>
          </Tooltip>
        </> : null}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem] text-fg/muted">
      {detail.threads.map(owner => <WorkbenchGitThreadChip key={owner.id} owner={owner} />)}
      <span>{detail.author}</span>
      <Tooltip content={formatLongTimestamp(detail.authoredAt)} placement="top">
        <span>{formatThreadRelativeTimestamp(detail.authoredAt / 1000, Date.now())}</span>
      </Tooltip>
      <CopySha sha={object.sha} />
    </div>
    {detail.body ? <p className="m-0 whitespace-pre-wrap text-sm text-fg/muted">{detail.body}</p> : null}
    {failure ? <p role="alert" className="m-0 text-sm text-danger">{failure}</p> : null}
    {conflicts.length ? <div role="status" className="space-y-1 rounded-xl bg-amber-500/10 px-3 py-2 text-sm">
      <p className="m-0 text-amber-700 dark:text-amber-300">Restored with conflict markers. The stash is kept.</p>
      {conflicts.map(file => <p key={file} className="m-0 font-mono text-xs text-text">{file}</p>)}
    </div> : null}
    {disturbs ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm">
      <span className="text-amber-700 dark:text-amber-300">Moves HEAD under</span>
      {disturbs.map(owner => <WorkbenchGitThreadChip key={owner.id} owner={owner} />)}
      <span className="flex-1" />
      <PrimaryButton shape="compact" tone="danger" holdToConfirmMs={HOLD_MS * 2} disabled={busy !== null}
        onClick={() => void run({ ...base, action: "undoCommit", sha: object.sha, disturb: true })}>
        Undo anyway
      </PrimaryButton>
    </div> : null}
  </header>;
}
