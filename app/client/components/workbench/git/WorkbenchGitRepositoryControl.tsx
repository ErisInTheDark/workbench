/* Exports: default WorkbenchGitRepositoryControl: repository navigation, branch metadata and peer Pull/Send within the shell header. */
"use client";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import WorkbenchTag from "../WorkbenchTag";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { ChevronDownIcon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeDaemonId, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitRepositoryControl () {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const daemonId = useWorkingTreeDaemonId();
  const menu = useWorkbenchContextMenu();
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    {snapshot.data.repositories.length > 1 ? <PrimaryButton aria-label="Git repository" disabled={snapshot.busy}
      onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        menu.openContextMenu({
          x: bounds.left, y: bounds.bottom, menu: {
            id: "working-tree-repositories", label: "Git repository",
            items: snapshot.data.repositories.map(repository => ({
              id: repository.rootId, label: repository.label,
              onSelect: () => state.selectRoot(repository.rootId),
            })),
          }
        });
      }}>
      <span className="max-w-48 truncate">{state.repository?.label}</span><ChevronDownIcon size={14} />
    </PrimaryButton> : null}
    {snapshot.initialising && !state.repository ? <span aria-label="Loading repository" className="inline-block h-5 w-16 rounded-full workbench-skeleton" />
      : <>
        <WorkbenchTag>{state.repository?.branch ?? (state.repository?.head ? "Detached HEAD" : "Working-tree changes")}</WorkbenchTag>
        <GitPeerButtons location={daemonId && state.projectId
          ? { daemonId: DaemonIdSchema.parse(daemonId), projectId: ProjectIdSchema.parse(state.projectId) } : null} />
        {snapshot.result && <span>{snapshot.result.message}</span>}
      </>}
  </span>;
}

/** Pull and Send for each peer folder on the same branch, shown only while there is something to move. */
function GitPeerButtons ({ location }: { location: ProjectLocationReference | null }) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const peers = snapshot.data?.peers.filter(peer => peer.state === "current" && (peer.ahead || peer.behind)) ?? [];
  if (!state || !peers.length) return null;
  const named = peers.length > 1;
  return <>{peers.flatMap(peer => {
    const busy = snapshot.busy === `${peer.daemonId}/${peer.projectId}`;
    const suffix = named ? ` · ${peer.hostname}` : "";
    return [
      ...peer.behind ? [<PrimaryButton key={`pull:${peer.daemonId}/${peer.projectId}`} shape="compact" pendingHalo={busy}
        disabled={snapshot.busy !== null} title={`Pull ${peer.behind} from ${peer.hostname}: ${peer.rootPath}`}
        onClick={() => void state.transfer("pull", peer)}>Pull {peer.behind}{suffix}</PrimaryButton>] : [],
      ...peer.ahead ? [<PrimaryButton key={`send:${peer.daemonId}/${peer.projectId}`} shape="compact" pendingHalo={busy}
        disabled={snapshot.busy !== null} title={`Send ${peer.ahead} to ${peer.hostname}: ${peer.rootPath}`}
        onClick={() => void state.transfer("send", peer)}>Send {peer.ahead}{suffix}</PrimaryButton>] : [],
    ];
  })}</>;
}
