/*
 * Exports:
 * - default WorkbenchGitHistoryList: a folder's HEAD history, newest first, growing as it scrolls; an accent bar and arrow
 *   mark commits not on the upstream, and a send glyph marks commits a peer still lacks.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { GIT_HISTORY_MAX_LIMIT, type GitHistory } from "workbench-shared/workbench/git/git-history-contracts";
import type { GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { formatLongTimestamp, formatThreadRelativeTimestamp } from "../thread-view/thread-view-formatters";
import { ArrowUpIcon, SendHorizontalIcon } from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";

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

export default function WorkbenchGitHistoryList({ location, peers, href }: {
  location: ProjectLocationReference;
  peers: readonly GitPeerAddress[];
  /** Where a commit row leads. */
  href: string | undefined;
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
  const now = Date.now();
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
      {data.commits.map(commit => (
        <li key={commit.commit}>
          <a
            className={`
              relative block rounded-lg py-1.5 pl-3 pr-2 hover:bg-fg/3
              ${commit.unpushed ? "before:(absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent content-[''])" : ""}
            `}
            href={href}
            title={`${commit.commit.slice(0, 12)} · ${formatLongTimestamp(commit.authoredAt)}`}
          >
            <span className="line-clamp-2 block text-[0.88rem] leading-snug text-text">{commit.subject}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[0.74rem] text-fg/muted">
              <span className="truncate">
                {commit.author} · {formatThreadRelativeTimestamp(commit.authoredAt / 1000, now)}
              </span>
              {commit.unpushed ? (
                <span className="inline-flex items-center text-accent" title="Not on the upstream yet"><ArrowUpIcon size={12} /></span>
              ) : null}
              {commit.unsent ? (
                <span className="inline-flex items-center text-accent" title="A peer device lacks this commit"><SendHorizontalIcon size={12} /></span>
              ) : null}
            </span>
          </a>
        </li>
      ))}
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
