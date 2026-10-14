/* Exports: default WorkbenchGitSidebar: render selected-project unclaimed Git status, peer folders' new commits and navigation. */
"use client";
import { useEffect, type MouseEvent } from "react";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useGitPeerState, type WorkbenchGitPeerOutcome } from "../../../workbench/git/WorkbenchGitPeerState";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import PrimaryButton from "../../ui/PrimaryButton";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import { BotIcon, GitArcCleanClaimIcon, GitArcDirtyClaimIcon, GitGraphIcon } from "../workbench-icons";
import WorkbenchSidebarSectionDisclosure from "../WorkbenchSidebarSectionDisclosure";
import { useWorkbenchSidebarPreferences } from "../workbench-sidebar-preferences-context";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";
import WorkbenchGitPeerTransferButton from "./WorkbenchGitPeerTransferButton";

const PEER_ROW = "flex min-h-8 items-center gap-2 pl-2 text-[0.8rem] leading-5";
const BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";

function blockedPrompt(outcome: WorkbenchGitPeerOutcome, branch: string | null) {
  const direction = outcome.action === "pull" ? `Pulling \`${branch ?? "the branch"}\` from ${outcome.peer.hostname} (\`${outcome.peer.rootPath}\`)`
    : `Sending \`${branch ?? "the branch"}\` to ${outcome.peer.hostname} (\`${outcome.peer.rootPath}\`)`;
  const conflicts = outcome.conflicts.length
    ? `\n\nConflicting files:\n\n${outcome.conflicts.map(file => `- \`${file}\``).join("\n")}` : "";
  const guidance = outcome.mode === "merge"
    ? "The selected mode preserves both histories. Inspect current ancestry before proposing a merge on the receiving device."
    : "The selected mode rebases incoming commits on their owning (sending) device, then fast-forwards the receiver. Do not replay published receiving-device commits.";
  const affected = !outcome.location ? "uncertain; inspect both devices"
    : outcome.location.daemonId === outcome.peer.daemonId && outcome.location.projectId === outcome.peer.projectId
      ? `${outcome.peer.hostname}:${outcome.peer.rootPath}` : "the selected folder";
  return `${direction} using ${outcome.mode} needs attention: ${outcome.reason}${conflicts}\n\nAffected location: ${affected}. ${guidance} Completion state: ${outcome.progress}. Inspect both sides before further integration; preserve local work on both sides. \`wb git --help\` lists manual integration steps.`;
}

function GitPeerRows ({ location, onAskAgent }: {
  location: ProjectLocationReference;
  onAskAgent(projectId: string, references: readonly PresentationDraftReference[]): void;
}) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  if (!state || !snapshot.data) return null;
  const branch = snapshot.data.branch;
  return <>
    {snapshot.data.peers.map(peer => {
      const key = `${peer.daemonId}/${peer.projectId}`;
      const outcome = snapshot.outcome && `${snapshot.outcome.peer.daemonId}/${snapshot.outcome.peer.projectId}` === key
        ? snapshot.outcome : null;
      if (!outcome && peer.state === "unsupported") return <p key={key} className={`${PEER_ROW} m-0 text-fg/muted`} title={peer.failure ?? undefined}>
        Update Workbench on {peer.hostname} to sync
      </p>;
      if (!outcome && peer.state === "failed") return <p key={key} className={`${PEER_ROW} m-0 text-fg/muted`} title={peer.failure ?? undefined}>
        Can't read {peer.hostname}
      </p>;
      if (!outcome && (peer.state !== "current" || !peer.behind && snapshot.busy?.peerKey !== key)) return null;
      return <div key={key} className="space-y-1">
        <div className={PEER_ROW} title={peer.rootPath}>
          <span className="min-w-0 flex-1 truncate text-text">
            {snapshot.busy?.peerKey === key ? `Syncing with ${peer.hostname}...`
              : peer.state !== "current" ? `${peer.hostname} unavailable` : `${peer.behind} new on ${peer.hostname}`}
          </span>
          <WorkbenchGitPeerTransferButton className={BUTTON} location={location} peer={peer} action="pull" />
        </div>
        {outcome ? <div className={`${PEER_ROW} flex-wrap`} title={outcome.conflicts.join("\n") || undefined}>
          <span className="min-w-0 flex-1 text-text" role="status">{outcome.reason}</span>
          {outcome.progress !== "complete" ? <PrimaryButton className={BUTTON} shape="compact" tone="attention"
            onClick={() => onAskAgent(location.projectId, [{ kind: "updateIssue", text: blockedPrompt(outcome, branch) }])}>
            <BotIcon className="mr-1" size={14} />Ask agent
          </PrimaryButton> : null}
        </div> : null}
      </div>;
    })}
  </>;
}

export default function WorkbenchGitSidebar ({ active, location, route, onAskAgent, onNavigate }: {
  active: boolean; location: ProjectLocationReference; route: WorkbenchRoute;
  onAskAgent(projectId: string, references: readonly PresentationDraftReference[]): void;
  onNavigate (event: MouseEvent<HTMLAnchorElement>): void;
}) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const { preferences } = useWorkbenchSidebarPreferences();
  useEffect(() => preferences.gitOpen ? state.acquireDemand("summary") : undefined, [preferences.gitOpen, state]);
  const projectHref = useWorkbenchProjectNavigation();
  if (!state.projectId) return null;
  const dirty = snapshot.summary.repositories.some(repository => repository.dirty);
  const Icon = dirty ? GitArcDirtyClaimIcon : GitArcCleanClaimIcon;
  const label = snapshot.summaryStatus === "idle" || snapshot.summaryStatus === "loading" ? "Checking changes..."
    : snapshot.summaryStatus === "error" || snapshot.summary.errors.length ? "Changes unavailable"
      : snapshot.summaryStatus === "unavailable" ? "Git unavailable"
        : dirty ? "Uncommitted changes" : "No changes";
  return <section className="shrink-0 pb-3">
    <WorkbenchSidebarSectionDisclosure icon={GitGraphIcon} preferenceKey="gitOpen" title="Git">
      <a href={projectHref(route, "exact")} onClick={onNavigate} aria-current={active ? "page" : undefined} className={`
        ${workbenchOptionRowClassName} min-h-9 w-full md:min-h-8
        ${active ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
      `}>
        <Icon size={16} />
        <span className={workbenchThreadListLabelClassName}>{label}</span>
      </a>
      {preferences.gitOpen ? <GitPeerRows location={location} onAskAgent={onAskAgent} /> : null}
    </WorkbenchSidebarSectionDisclosure>
  </section>;
}
