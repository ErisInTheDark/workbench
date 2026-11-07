/*
 * Exports:
 * - default WorkbenchGitSidebar: the sidebar git panel for the browsed folder: its sync card, the unclaimed-changes row,
 *   the folder's stashes, then its commit history; each row opens a git tab for what it names.
 */
"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { WorkbenchGitTarget, type WorkbenchGitObject } from "workbench-shared/workbench/navigation/git-route-target";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import { useWorkbenchNavigate, useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchClientController } from "../workbench-client-context";
import { workbenchOptionHoverClassName, workbenchOptionRowClassName, workbenchOptionSelectedClassName, workbenchThreadListLabelClassName } from "../workbench-class-names";
import { GitArcCleanClaimIcon, GitArcDirtyClaimIcon } from "../workbench-icons";
import { useWorkbenchWorkspace, WorkbenchOperationsContext } from "../WorkbenchWorkspaceContext";
import useGitObjectMenu, { type GitObjectOpen } from "./use-git-object-menu";
import WorkbenchGitHistoryList from "./WorkbenchGitHistoryList";
import WorkbenchGitStashRows from "./WorkbenchGitStashRows";
import WorkbenchGitSyncCard, { type WorkbenchGitAskAgent } from "./WorkbenchGitSyncCard";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
type OpenGit = (folder: ProjectLocationReference) => void;
/** A valid object id no real object has, standing in for each row's sha in a shared href. */
const SHA_SLOT = "0".repeat(40);

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
  onAskAgent: WorkbenchGitAskAgent;
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
        <WorkbenchGitSyncCard location={location} onAskAgent={onAskAgent} openGit={openGit} />
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
