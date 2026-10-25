/*
 * Exports:
 * - default WorkbenchGitSidebar: the sidebar git panel for the browsed folder: one sync card (branch menu, upstream push and
 *   pull, pull and send for each peer device), the unclaimed-changes row, the folder's stashes, then its commit history;
 *   each row opens a git tab for what it names.
 */
"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { GitPeerAddress, GitPeerTransfer } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { WorkbenchGitTarget, type WorkbenchGitObject } from "workbench-shared/workbench/navigation/git-route-target";
import { useGitPeerState, type WorkbenchGitPeerOutcome, type WorkbenchGitUpstreamOutcome } from "../../../workbench/git/WorkbenchGitPeerState";
import { useWorkbenchNavigate, useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { useWorkbenchClientController } from "../workbench-client-context";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import {
  ArrowUpIcon, BotIcon, GitArcCleanClaimIcon, GitArcDirtyClaimIcon, GitFastForwardIcon, GitMergeIcon, GitRebaseIcon,
} from "../workbench-icons";
import { useWorkbenchWorkspace, WorkbenchOperationsContext } from "../WorkbenchWorkspaceContext";
import useGitObjectMenu, { type GitObjectOpen } from "./use-git-object-menu";
import WorkbenchGitBranchMenu from "./WorkbenchGitBranchMenu";
import WorkbenchGitHistoryList from "./WorkbenchGitHistoryList";
import WorkbenchGitStashRows from "./WorkbenchGitStashRows";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";
import WorkbenchGitPeerTransferButton from "./WorkbenchGitPeerTransferButton";
import WorkbenchGitSyncButton from "./WorkbenchGitSyncButton";

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
type OpenGit = (folder: ProjectLocationReference) => void;
/** A valid object id no real object has, standing in for each row's sha in a shared href. */
const SHA_SLOT = "0".repeat(40);

/** The branch, then push and pull with the upstream and pull or send for each peer folder, each shown only while it has something to move. */
function SyncCard({ location, onAskAgent, openGit }: { location: ProjectLocationReference; onAskAgent: AskAgent; openGit: OpenGit }) {
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

export default function WorkbenchGitSidebar({ location, route, onAskAgent }: {
  location: ProjectLocationReference;
  /** The current route; git rows open tabs from it and highlight what its git tab shows. */
  route: WorkbenchRoute;
  onAskAgent: AskAgent;
}) {
  const state = useWorkingTree();
  useEffect(() => state.acquireDemand("summary"), [state]);
  const projectHref = useWorkbenchProjectNavigation();
  const navigate = useWorkbenchNavigate();
  const mounted = useWorkbenchClientController().mounted;
  const navigator = mounted?.projectNavigator;
  const daemon = useMemo(() => mounted?.workspace.daemon({ kind: "folder", location }) ?? null,
    [location.daemonId, location.projectId, mounted]);
  const { snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const peers = useMemo(() => (snapshot.data?.peers ?? []).filter(peer => peer.state === "current"), [snapshot.data?.peers]);
  // One href per object kind, built once per route; rows swap in their sha so thousands of rows cost no route work.
  const templates = useMemo(() => {
    if (!navigator) return null;
    const build = (object: WorkbenchGitObject) => projectHref(navigator.gitRoute(route, location, object));
    return { commit: build({ kind: "commit", sha: SHA_SLOT }), stash: build({ kind: "stash", sha: SHA_SLOT }), changes: build(WorkbenchGitTarget.changes) };
  }, [location, navigator, projectHref, route]);
  const commitHref = useCallback((sha: string) => templates?.commit?.replace(SHA_SLOT, sha), [templates?.commit]);
  const stashHref = useCallback((sha: string) => templates?.stash?.replace(SHA_SLOT, sha), [templates?.stash]);
  // The latest route is read at open time, so the callback (and every memoized row holding it) survives navigation.
  const latest = useRef({ route, navigator });
  latest.current = { route, navigator };
  const openObject = useCallback<GitObjectOpen>((target, tab) => {
    const { route: current, navigator: owner } = latest.current;
    if (owner) navigate(owner.gitRoute(current, location, target), { tab });
  }, [location, navigate]);
  if (!state.projectId || !navigator || !daemon) return null;
  const shown = route.view === "git" ? navigator.gitLocationFor(route) : null;
  const here = shown?.daemonId === location.daemonId && shown.projectId === location.projectId;
  const object = here ? route.gitTarget?.object ?? WorkbenchGitTarget.changes : null;
  const openGit: OpenGit = folder => navigate(navigator.gitRoute(route, folder));
  return (
    <WorkbenchOperationsContext.Provider value={daemon}>
      <section className="shrink-0 pb-3 pl-2">
        <SyncCard location={location} onAskAgent={onAskAgent} openGit={openGit} />
        <UnclaimedRow active={object?.kind === "changes"} href={templates?.changes} />
        <ObjectRows location={location} object={object} open={openObject} commitHref={commitHref} stashHref={stashHref} peers={peers} />
      </section>
    </WorkbenchOperationsContext.Provider>
  );
}

/** Stash and history rows, inside the folder's daemon so their menus and hover cards reach it. */
function ObjectRows({ location, object, open, commitHref, stashHref, peers }: {
  location: ProjectLocationReference;
  object: WorkbenchGitObject | null;
  open: GitObjectOpen;
  commitHref(sha: string): string | undefined;
  stashHref(sha: string): string | undefined;
  peers: readonly GitPeerAddress[];
}) {
  const onMenu = useGitObjectMenu(location, open);
  return <>
    <WorkbenchGitStashRows location={location} activeSha={object?.kind === "stash" ? object.sha : null} href={stashHref} onMenu={onMenu} />
    <WorkbenchGitHistoryList
      activeSha={object?.kind === "commit" ? object.sha : null}
      href={commitHref}
      key={`${location.daemonId}/${location.projectId}`}
      location={location}
      onMenu={onMenu}
      peers={peers}
    />
  </>;
}
