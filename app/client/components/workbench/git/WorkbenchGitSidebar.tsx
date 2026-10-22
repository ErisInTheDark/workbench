/*
 * Exports:
 * - default WorkbenchGitSidebar: the sidebar git panel for the browsed folder: one sync card (branch, upstream push, pull
 *   and send for each peer device), the unclaimed-changes row opening the git view, then the folder's commit history.
 */
"use client";
import { useEffect } from "react";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useGitPeerState, type WorkbenchGitPeerOutcome } from "../../../workbench/git/WorkbenchGitPeerState";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import { ArrowUpIcon, BotIcon, GitArcCleanClaimIcon, GitArcDirtyClaimIcon, GitGraphIcon } from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import WorkbenchGitHistoryList from "./WorkbenchGitHistoryList";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";
import WorkbenchGitPeerTransferButton from "./WorkbenchGitPeerTransferButton";

const SYNC_ROW = "flex min-h-8 items-center gap-2 px-1 text-[0.84rem] leading-5";
const BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";
type AskAgent = (projectId: string, references: readonly PresentationDraftReference[]) => void;

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

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Push to the upstream and pull or send for each peer folder, each shown only while it has something to move. */
function SyncCard({ location, onAskAgent }: { location: ProjectLocationReference; onAskAgent: AskAgent }) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const data = snapshot.data;
  if (!state || !data) return null;
  const upstream = data.upstream ?? null;
  const remote = upstream?.name.split("/")[0] ?? "upstream";
  return (
    <div className="mb-2 space-y-1 rounded-[0.9rem] border border-fg-alpha/16 bg-fg/3 p-2">
      <div className="flex min-w-0 items-center gap-2 px-1 text-[0.8rem] text-fg/muted">
        <GitGraphIcon size={14} />
        <span className="min-w-0 max-w-[60%] truncate rounded-full bg-fg/8 px-2 py-0.5 text-[0.72rem] text-text">
          {data.branch ?? "Detached HEAD"}
        </span>
        <span className="min-w-0 truncate">{upstream ? `tracking ${upstream.name}` : data.branch ? "no upstream" : ""}</span>
      </div>
      {upstream?.ahead || snapshot.pushing ? (
        <div className={SYNC_ROW}>
          <span className="min-w-0 flex-1 truncate text-text">{plural(upstream?.ahead ?? 0, "commit")} not on {remote}</span>
          <PrimaryButton className={BUTTON} disabled={snapshot.pushing} onClick={() => void state.push()}
            pendingHalo={snapshot.pushing} shape="compact">
            <ArrowUpIcon className="mr-1" size={14} />Push {upstream?.ahead ?? ""}
          </PrimaryButton>
        </div>
      ) : null}
      {upstream?.behind ? (
        <p className={`${SYNC_ROW} m-0 text-fg/muted`}>{plural(upstream.behind, "new commit")} on {remote}</p>
      ) : null}
      {snapshot.pushFailure ? (
        <p className="m-0 px-1 text-[0.74rem] leading-4 text-danger" role="status">{snapshot.pushFailure}</p>
      ) : null}
      {data.peers.map(peer => {
        const key = `${peer.daemonId}/${peer.projectId}`;
        const outcome = snapshot.outcome && `${snapshot.outcome.peer.daemonId}/${snapshot.outcome.peer.projectId}` === key
          ? snapshot.outcome : null;
        if (!outcome && (peer.state === "unsupported" || peer.state === "failed")) {
          return <Tooltip key={key} interactive content={peer.failure} enabled={Boolean(peer.failure)}>
            <p className={`${SYNC_ROW} m-0 text-fg/muted`}>
              {peer.state === "unsupported" ? `Update Workbench on ${peer.hostname} to sync` : `Can't read ${peer.hostname}`}
            </p>
          </Tooltip>;
        }
        const busy = snapshot.busy?.peerKey === key;
        if (!outcome && !busy && (peer.state !== "current" || !peer.behind && !peer.ahead)) return null;
        return <div key={key} className="space-y-1">
          {peer.behind || busy && snapshot.busy?.action === "pull" ? (
            <div className={SYNC_ROW}>
              <Tooltip interactive content={<span className="break-all">{peer.rootPath}</span>}>
                <span className="min-w-0 flex-1 truncate text-text">
                  {busy ? `Syncing with ${peer.hostname}...` : `${peer.behind} new on ${peer.hostname}`}
                </span>
              </Tooltip>
              <WorkbenchGitPeerTransferButton className={BUTTON} location={location} peer={peer} action="pull" />
            </div>
          ) : null}
          {peer.ahead ? (
            <div className={SYNC_ROW}>
              <Tooltip interactive content={<span className="break-all">{peer.rootPath}</span>}>
                <span className="min-w-0 flex-1 truncate text-fg/muted">{peer.ahead} not on {peer.hostname} yet</span>
              </Tooltip>
              <WorkbenchGitPeerTransferButton className={BUTTON} location={location} peer={peer} action="send" showCount />
            </div>
          ) : null}
          {outcome ? <div className={`${SYNC_ROW} flex-wrap`}>
            <Tooltip interactive enabled={outcome.conflicts.length > 0} content={<div className="max-w-80 space-y-1">
              <div className="font-medium">Conflicting files</div>
              {outcome.conflicts.map(path => <div key={path} className="break-all">{path}</div>)}
            </div>}>
              <span className="min-w-0 flex-1 text-[0.8rem] text-text" role="status">{outcome.reason}</span>
            </Tooltip>
            {outcome.progress !== "complete" ? <PrimaryButton className={BUTTON} shape="compact" tone="attention"
              onClick={() => onAskAgent(location.projectId, [{ kind: "updateIssue", text: blockedPrompt(outcome, data.branch) }])}>
              <BotIcon className="mr-1" size={14} />Ask agent
            </PrimaryButton> : null}
          </div> : null}
        </div>;
      })}
    </div>
  );
}

function UnclaimedRow({ active, href }: { active: boolean; href: string | undefined }) {
  const snapshot = useWorkingTreeSnapshot();
  const unclaimed = snapshot.summary.repositories.reduce((total, repository) =>
    total + (repository.unclaimed ?? (repository.dirty ? 1 : 0)), 0);
  const counted = snapshot.summary.repositories.every(repository => repository.unclaimed !== undefined);
  const Icon = unclaimed ? GitArcDirtyClaimIcon : GitArcCleanClaimIcon;
  const label = snapshot.summaryStatus === "idle" || snapshot.summaryStatus === "loading" ? "Checking changes..."
    : snapshot.summaryStatus === "error" || snapshot.summary.errors.length ? "Changes unavailable"
      : snapshot.summaryStatus === "unavailable" ? "Git unavailable"
        : !unclaimed ? "No unclaimed changes" : counted ? plural(unclaimed, "unclaimed change") : "Unclaimed changes";
  return (
    <a href={href} aria-current={active ? "page" : undefined} className={`
      ${workbenchOptionRowClassName} mb-1 min-h-9 w-full md:min-h-8
      ${active ? `${workbenchOptionSelectedClassName} text-text` : `${workbenchOptionHoverClassName} border-transparent text-fg/muted hover:text-text`}
    `}>
      <Icon size={16} />
      <span className={workbenchThreadListLabelClassName}>{label}</span>
    </a>
  );
}

export default function WorkbenchGitSidebar({ active, location, route, onAskAgent }: {
  active: boolean; location: ProjectLocationReference; route: WorkbenchRoute; onAskAgent: AskAgent;
}) {
  const state = useWorkingTree();
  useEffect(() => state.acquireDemand("summary"), [state]);
  const projectHref = useWorkbenchProjectNavigation();
  const { snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const peers = (snapshot.data?.peers ?? []).filter(peer => peer.state === "current");
  if (!state.projectId) return null;
  const href = projectHref(route, { selection: "exact" });
  return (
    <section className="shrink-0 pb-3 pl-2">
      <SyncCard location={location} onAskAgent={onAskAgent} />
      <UnclaimedRow active={active} href={href} />
      <WorkbenchGitHistoryList
        href={href}
        key={`${location.daemonId}/${location.projectId}`}
        location={location}
        peers={peers}
      />
    </section>
  );
}
