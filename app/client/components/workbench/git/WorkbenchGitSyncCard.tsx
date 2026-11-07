/*
 * Exports:
 * - default WorkbenchGitSyncCard: a folder's sync card: branch menu, upstream push and pull, and pull and send for each
 *   peer device, each row shown only while it has something to move, with ask-agent prompts for blocked transfers.
 * - WorkbenchGitAskAgent: hands a blocked transfer's prompt to a new agent draft in the folder's project.
 */
"use client";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { GitPeerTransfer } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState, type WorkbenchGitPeerOutcome, type WorkbenchGitUpstreamOutcome } from "../../../workbench/git/WorkbenchGitPeerState";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { useWorkbenchClientController } from "../workbench-client-context";
import { ArrowUpIcon, BotIcon, GitFastForwardIcon, GitMergeIcon, GitRebaseIcon } from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import WorkbenchGitBranchMenu from "./WorkbenchGitBranchMenu";
import WorkbenchGitPeerTransferButton from "./WorkbenchGitPeerTransferButton";
import WorkbenchGitSyncButton from "./WorkbenchGitSyncButton";

const SYNC_ROW = "flex min-h-8 items-center gap-2 px-1 text-[0.84rem] leading-5";
const BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";
export type WorkbenchGitAskAgent = (projectId: string, references: readonly PresentationDraftReference[]) => void;

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

function upstreamBlockedPrompt(outcome: WorkbenchGitUpstreamOutcome, branch: string | null, upstream: string) {
  const conflicts = outcome.conflicts.length
    ? `\n\nConflicting files:\n\n${outcome.conflicts.map(file => `- \`${file}\``).join("\n")}` : "";
  const mode = outcome.mode === "fastForward" ? "fast-forward" : outcome.mode ?? "the default mode";
  return `Pulling \`${upstream}\` into \`${branch ?? "the branch"}\` using ${mode} needs attention: ${outcome.reason}${conflicts}\n\nInspect the branch and \`${upstream}\` before integrating; preserve local work and never rewrite published commits. \`wb git integrate --help\` lists the integration steps.`;
}

function ConflictList({ paths }: { paths: readonly string[] }) {
  return <div className="max-w-80 space-y-1">
    <div className="font-medium">Conflicting files</div>
    {paths.map(path => <div key={path} className="break-all">{path}</div>)}
  </div>;
}

function UpstreamPullTooltip({ mode, upstream, remote, unavailable }: {
  mode: GitPeerTransfer["mode"]; upstream: string; remote: string; unavailable: string | null;
}) {
  const Icon = mode === "fastForward" ? GitFastForwardIcon : mode === "merge" ? GitMergeIcon : GitRebaseIcon;
  return <div className="max-w-80">
    <div className="flex items-center gap-2 font-medium">
      <Icon size={16} />
      <span className="min-w-0 break-all">{mode === "fastForward" ? "Fast-forward" : mode === "merge" ? "Merge" : "Rebase"} from {upstream}</span>
    </div>
    <p className="m-0 mt-1 text-fg/muted">{unavailable ?? `Fetches ${remote} first.`}</p>
  </div>;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export default function WorkbenchGitSyncCard({ location, onAskAgent, openGit }: {
  location: ProjectLocationReference;
  onAskAgent: WorkbenchGitAskAgent;
  openGit(folder: ProjectLocationReference): void;
}) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const client = useWorkbenchClientController();
  const data = snapshot.data;
  if (!state || !data) return null;
  const upstream = data.upstream ?? null;
  const remote = upstream?.name.split("/")[0] ?? "upstream";
  const pushing = snapshot.upstreamBusy?.action === "push";
  const pulling = snapshot.upstreamBusy?.action === "pull";
  const upstreamOutcome = snapshot.upstreamOutcome;
  const folderAt = (worktree: string) => {
    const key = worktree.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    return client.mounted?.projectNavigator.folderOptions().find(folder => folder.target.daemonId === location.daemonId
      && folder.rootPath.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase() === key)?.target ?? null;
  };
  return (
    <div className="mb-2 space-y-1 rounded-[0.9rem] border border-fg-alpha/16 bg-fg/3 p-2">
      <div className="min-w-0 px-1 text-[0.8rem] text-fg/muted">
        <WorkbenchGitBranchMenu location={location} current={data.branch}
          openFolder={worktree => { const folder = folderAt(worktree); if (folder) openGit(folder); }}
          openWorktree={openGit} />
      </div>
      {upstream?.ahead || pushing ? (
        <div className={SYNC_ROW}>
          <span className="min-w-0 flex-1 truncate text-text">{plural(upstream?.ahead ?? 0, "commit")} not on {remote}</span>
          <PrimaryButton className={BUTTON} disabled={snapshot.upstreamBusy !== null} onClick={() => void state.push()}
            pendingHalo={pushing} shape="compact">
            <ArrowUpIcon className="mr-1" size={14} />Push {upstream?.ahead ?? ""}
          </PrimaryButton>
        </div>
      ) : null}
      {upstream && (upstream.behind || pulling) ? (
        <div className={SYNC_ROW}>
          <span className="min-w-0 flex-1 truncate text-text">
            {pulling ? `Pulling from ${remote}...` : `${plural(upstream.behind, "new commit")} on ${remote}`}
          </span>
          <WorkbenchGitSyncButton className={BUTTON} location={location} verb="Pull" menuId={`git-upstream-pull-${location.daemonId}-${location.projectId}`}
            fastForward={upstream.ahead === 0} busyMode={pulling ? snapshot.upstreamBusy?.mode ?? null : null}
            disabled={snapshot.upstreamBusy !== null} onTransfer={mode => void state.pull(mode)}
            tooltip={(mode, unavailable) => <UpstreamPullTooltip mode={mode} upstream={upstream.name} remote={remote} unavailable={unavailable} />} />
        </div>
      ) : null}
      {upstreamOutcome ? (
        <div className={`${SYNC_ROW} flex-wrap`}>
          <Tooltip interactive enabled={upstreamOutcome.conflicts.length > 0} content={<ConflictList paths={upstreamOutcome.conflicts} />}>
            <span className={`
              min-w-0 flex-1 text-[0.8rem] leading-4
              ${upstreamOutcome.kind === "failed" ? "text-danger" : "text-text"}
            `} role="status">{upstreamOutcome.reason}</span>
          </Tooltip>
          {upstreamOutcome.kind === "blocked" && upstream ? <PrimaryButton className={BUTTON} shape="compact" tone="attention"
            onClick={() => onAskAgent(location.projectId, [{ kind: "updateIssue", text: upstreamBlockedPrompt(upstreamOutcome, data.branch, upstream.name) }])}>
            <BotIcon className="mr-1" size={14} />Ask agent
          </PrimaryButton> : null}
        </div>
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
            <Tooltip interactive enabled={outcome.conflicts.length > 0} content={<ConflictList paths={outcome.conflicts} />}>
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
