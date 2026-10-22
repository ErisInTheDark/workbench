/*
 * Exports:
 * - default WorkbenchGitHistoryList: a folder's HEAD history, newest first, growing as it scrolls; each row opens its commit
 *   in a git tab, hovers a commit card and right-clicks a commit menu. An accent bar and arrow mark commits not on the
 *   upstream, and a send glyph marks commits a peer lacks.
 */
"use client";

import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { GIT_HISTORY_MAX_LIMIT, type GitHistory, type GitHistoryCommit } from "workbench-shared/workbench/git/git-history-contracts";
import type { GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { formatThreadRelativeTimestamp } from "../thread-view/thread-view-formatters";
import Tooltip from "../../ui/Tooltip";
import { ArrowUpIcon, SendHorizontalIcon } from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import type { GitMenuObject } from "./use-git-object-menu";
import WorkbenchGitObjectTooltip from "./WorkbenchGitObjectTooltip";

const PAGE = 50;

/** The last page stays visible while a deeper one loads, so scrolling never blanks the list. */
function useGitHistory(location: ProjectLocationReference, peers: readonly GitPeerAddress[], limit: number) {
  const workspace = useWorkbenchWorkspace();
  const [state, setState] = useState<{ data: GitHistory | null; loading: boolean; failure: string | null }>(
    { data: null, loading: true, failure: null });
  // Peer rows rebuild on every peer fact; only a changed peer set reopens the observation.
  const peersKey = peers.map(peer => `${peer.daemonId}/${peer.projectId}`).join("\n");
  const latestPeers = useRef(peers);
  latestPeers.current = peers;
  useEffect(() => {
    const handle = workspace.observe({
      kind: "gitHistory", location: { daemonId: location.daemonId, projectId: location.projectId }, limit,
      peers: latestPeers.current.map(peer => ({ daemonId: peer.daemonId, projectId: peer.projectId })),
    }, () => read());
    const read = () => {
      const fact = handle.getSnapshot();
      setState(previous => ({
        data: fact.value?.data ?? previous.data,
        loading: fact.phase === "pending",
        failure: fact.failure,
      }));
    };
    read();
    return () => handle.release();
  }, [limit, location.daemonId, location.projectId, peersKey, workspace]);
  return state;
}

/** Rows re-render only when their own commit, link or highlight changes, so switching tabs stays cheap in long histories. */
const HistoryRow = memo(function HistoryRow({ location, commit, active, href, onMenu }: {
  location: ProjectLocationReference;
  commit: GitHistoryCommit;
  active: boolean;
  href: string | undefined;
  onMenu(event: MouseEvent, object: GitMenuObject): void;
}) {
  const object = useMemo<GitMenuObject>(() => ({ kind: "commit", sha: commit.commit, named: Boolean(commit.subject) }),
    [commit.commit, commit.subject]);
  return <li>
    <Tooltip placement="right" content={<WorkbenchGitObjectTooltip location={location} object={object} subject={commit.subject}
      author={commit.author} at={commit.authoredAt} unpushed={commit.unpushed} unsent={commit.unsent} />}>
      <a
        aria-current={active ? "page" : undefined}
        className={`
          relative block rounded-lg py-1.5 pl-3 pr-2
          ${active ? "bg-fg/5" : "hover:bg-fg/3"}
          ${commit.unpushed ? "before:(absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent content-[''])" : ""}
        `}
        href={href}
        onContextMenu={event => onMenu(event, object)}
      >
        <span className="line-clamp-2 block text-[0.88rem] leading-snug text-text">{commit.subject}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[0.74rem] text-fg/muted">
          <span className="truncate">{commit.author} · {formatThreadRelativeTimestamp(commit.authoredAt / 1000, Date.now())}</span>
          {commit.unpushed ? <span className="inline-flex items-center text-accent"><ArrowUpIcon size={12} /></span> : null}
          {commit.unsent ? <span className="inline-flex items-center text-accent"><SendHorizontalIcon size={12} /></span> : null}
        </span>
      </a>
    </Tooltip>
  </li>;
});

export default function WorkbenchGitHistoryList({ location, peers, href, activeSha, onMenu }: {
  location: ProjectLocationReference;
  peers: readonly GitPeerAddress[];
  /** Where a commit row leads. */
  href(sha: string): string | undefined;
  /** The commit the focused git tab shows. */
  activeSha: string | null;
  onMenu(event: MouseEvent, object: GitMenuObject): void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { data, loading, failure } = useGitHistory(location, peers, limit);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = Boolean(data && !data.complete && limit < GIT_HISTORY_MAX_LIMIT);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !more || loading) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setLimit(current => Math.min(GIT_HISTORY_MAX_LIMIT, current + PAGE));
    }, { rootMargin: "200px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, more]);
  if (!data) {
    return failure ? <p className="m-0 px-3 py-1 text-[0.8rem] text-fg/muted">{failure}</p> : (
      <div aria-label="Loading commits" className="space-y-2 px-3 py-2">
        <div className="h-3.5 w-4/5 rounded workbench-skeleton" /><div className="h-2.5 w-1/3 rounded workbench-skeleton" />
      </div>
    );
  }
  if (!data.commits.length) return <p className="m-0 px-3 py-1 text-[0.8rem] text-fg/muted">No commits yet.</p>;
  return (
    <ol aria-label="Commit history" className="m-0 list-none p-0">
      {data.commits.map(commit => <HistoryRow key={commit.commit} location={location} commit={commit}
        active={activeSha === commit.commit} href={href(commit.commit)} onMenu={onMenu} />)}
      {more ? (
        <li>
          <div ref={sentinel} aria-label="Loading older commits" className="space-y-2 px-3 py-2">
            <div className="h-3.5 w-4/5 rounded workbench-skeleton" /><div className="h-2.5 w-1/3 rounded workbench-skeleton" />
          </div>
        </li>
      ) : null}
    </ol>
  );
}
