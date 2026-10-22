/*
 * Exports:
 * - default WorkbenchGitBranchMenu: a folder's branch as a press-drag menu: switch branches, or open a branch another
 *   worktree holds. A switch that would strand threads' claims or proposals offers a worktree first and switches in place
 *   only on a held confirm.
 */
"use client";
import { useState } from "react";
import type { GitCheckoutOwner, GitRefMutation } from "workbench-shared/workbench/git/git-object-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitBranches } from "../../../workbench/git/use-git-refs";
import PressDragMenu from "../../ui/PressDragMenu";
import PrimaryButton from "../../ui/PrimaryButton";
import TooltipIconButton from "../../ui/TooltipIconButton";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { ArrowUpIcon, ChevronDownIcon, FolderOpenIcon, GitBranchIcon, XIcon } from "../workbench-icons";
import WorkbenchGitThreadChip from "./WorkbenchGitThreadChip";

const HOLD_MS = 2_000;

export default function WorkbenchGitBranchMenu({ location, current, openFolder, openWorktree }: {
  location: ProjectLocationReference;
  /** The checked-out branch as the sync card already knows it, so the chip never waits for the branch list. */
  current: string | null;
  /** Opens a branch another worktree of this checkout holds, by that worktree's path. */
  openFolder(path: string): void;
  /** Opens a just-created worktree folder. */
  openWorktree(location: ProjectLocationReference): void;
}) {
  const daemon = useWorkbenchDaemonClient();
  const list = useGitBranches(location);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [disturbs, setDisturbs] = useState<{ branch: string; owners: GitCheckoutOwner[] } | null>(null);
  const branches = [...list?.branches ?? []].sort((left, right) =>
    Number(right.name === list?.current) - Number(left.name === list?.current));
  const run = async (mutation: GitRefMutation) => {
    setBusy(true);
    setFailure("");
    try {
      const result = await daemon.git.mutateRef(mutation);
      if (result.status === "disturbs" && mutation.action === "switchBranch") {
        setDisturbs({ branch: mutation.branch, owners: result.owners });
        return;
      }
      setDisturbs(null);
      if (result.status === "complete" && result.worktree?.projectId) {
        openWorktree({ daemonId: location.daemonId, projectId: result.worktree.projectId as ProjectLocationReference["projectId"] });
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const base = { projectId: location.projectId };
  return <div className="min-w-0 space-y-1">
    <PressDragMenu label="Branch" align="start" triggerAppearance="plain" disabled={busy || branches.length < 2}
      triggerClassName="max-w-full gap-1.5 rounded-full bg-fg/8 px-2 py-0.5 text-[0.76rem] text-text enabled:hover:bg-fg/12"
      items={branches.map(branch => ({
        id: branch.name, checked: branch.name === list?.current,
        content: <span className="flex min-w-52 items-center gap-2 text-[0.88rem]">
          <GitBranchIcon size={14} className="shrink-0 text-fg/muted" />
          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
          {branch.upstream?.ahead ? <span className="inline-flex items-center text-[0.74rem] tabular-nums text-accent">
            <ArrowUpIcon size={12} />{branch.upstream.ahead}
          </span> : null}
          {branch.worktree ? <FolderOpenIcon size={14} className="shrink-0 text-fg/muted" /> : null}
        </span>,
      }))}
      onSelect={id => {
        const branch = branches.find(candidate => candidate.name === id);
        if (!branch || branch.name === list?.current) return;
        if (branch.worktree) { openFolder(branch.worktree); return; }
        void run({ ...base, action: "switchBranch", branch: branch.name, disturb: false });
      }}>
      <GitBranchIcon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{list?.current ?? current ?? <em>detached</em>}</span>
      {branches.length > 1 ? <ChevronDownIcon size={12} className="shrink-0 text-fg/muted" /> : null}
    </PressDragMenu>
    {disturbs ? <div role="status" className="space-y-1.5 rounded-xl bg-amber-500/10 p-2 text-[0.8rem]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-amber-700 dark:text-amber-300">Moves HEAD under</span>
        {disturbs.owners.map(owner => <WorkbenchGitThreadChip key={owner.id} owner={owner} />)}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <PrimaryButton shape="compact" disabled={busy}
          onClick={() => void run({ ...base, action: "createWorktree", branch: disturbs.branch, create: false })}>
          <FolderOpenIcon size={14} className="mr-1" />Open in worktree
        </PrimaryButton>
        <PrimaryButton shape="compact" tone="danger" holdToConfirmMs={HOLD_MS} disabled={busy}
          onClick={() => void run({ ...base, action: "switchBranch", branch: disturbs.branch, disturb: true })}>
          Switch anyway
        </PrimaryButton>
        <TooltipIconButton size="small" label="Cancel" onClick={() => setDisturbs(null)}><XIcon size={14} /></TooltipIconButton>
      </div>
    </div> : null}
    {failure ? <p role="alert" className="m-0 px-1 text-[0.76rem] leading-4 text-danger">{failure}</p> : null}
  </div>;
}
