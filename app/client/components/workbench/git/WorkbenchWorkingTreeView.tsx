/* Exports: default WorkbenchWorkingTreeView: the working tree's files beside the focused diff and the sticky composer. */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import PrimaryButton from "../../ui/PrimaryButton";
import { GitArcCleanClaimIcon } from "../workbench-icons";
import WorkbenchGitChangesetProvider from "./WorkbenchGitChangesetProvider";
import WorkbenchGitComposer from "./WorkbenchGitComposer";
import WorkbenchGitDiffView from "./WorkbenchGitDiffView";
import WorkbenchGitFileList from "./WorkbenchGitFileList";
import WorkbenchGitRepositoryControl from "./WorkbenchGitRepositoryControl";
import WorkbenchGitSplitPane from "./WorkbenchGitSplitPane";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export function WorkbenchGitLoading() {
  return <div aria-label="Loading" aria-busy="true" className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[300px_minmax(0,1fr)]">
    <div aria-hidden="true" className="space-y-5 py-3">
      {Array.from({ length: 7 }, (_, index) => <div key={index} className="space-y-2">
        <div className="h-4 w-4/5 rounded workbench-skeleton" />
        <div className="h-3 w-1/2 rounded workbench-skeleton" />
      </div>)}
    </div>
    <div aria-hidden="true" className="hidden min-h-0 flex-col gap-3 py-3 md:flex">
      <div className="h-5 w-2/5 rounded workbench-skeleton" />
      {Array.from({ length: 14 }, (_, index) => <div key={index} className="h-4 rounded workbench-skeleton" style={{ width: `${[80, 64, 72, 40, 58][index % 5]}%` }} />)}
    </div>
  </div>;
}

export default function WorkbenchWorkingTreeView({ path }: { path: string | null }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  useEffect(() => state.acquireDemand("full"), [state]);
  useEffect(() => { if (path) state.selectFile(path); }, [path, state]);
  const [showDetail, setShowDetail] = useState(Boolean(path));
  const viewport = useRef<HTMLDivElement>(null);
  const getViewport = useCallback(() => viewport.current, []);
  if (!snapshot.data.repositories.length && (snapshot.status === "error" || snapshot.status === "unavailable")) {
    return <div className="flex flex-col items-start gap-3 py-4">
      <p role="alert" className="m-0 whitespace-pre-line text-sm text-danger">{snapshot.error}</p>
      <PrimaryButton disabled={snapshot.refreshing} onClick={() => { void state.refresh(); }}>Retry</PrimaryButton>
    </div>;
  }
  if (snapshot.initialising) return <WorkbenchGitLoading />;
  const clean = snapshot.status === "ready" && !state.repository?.files.length;
  return <WorkbenchGitChangesetProvider changeset={state}><div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    {snapshot.error || snapshot.operationError || snapshot.result?.warnings.length ? <div role="alert" className="space-y-1 px-1 pb-2 text-sm text-danger">
      {[snapshot.error, snapshot.operationError, ...snapshot.result?.warnings ?? []].filter(Boolean).map((message, index) => (
        <p key={index} className="m-0 whitespace-pre-line">{message}</p>
      ))}
    </div> : null}
    {clean ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-fg/muted">
      <WorkbenchGitRepositoryControl />
      <GitArcCleanClaimIcon size={32} />
    </div> : <WorkbenchGitSplitPane viewport={viewport} showDetail={showDetail} onShowFiles={() => setShowDetail(false)}
      files={<>
        <div className="px-1 pb-1"><WorkbenchGitRepositoryControl /></div>
        <WorkbenchGitFileList onSelect={() => setShowDetail(true)} />
      </>}>
      <div className="grid min-h-full min-w-0 grid-cols-1 grid-rows-[1fr_auto]">
        <div className="col-start-1 row-start-1 min-w-0"><WorkbenchGitDiffView /></div>
        <WorkbenchGitComposer getViewport={getViewport} />
      </div>
    </WorkbenchGitSplitPane>}
  </div></WorkbenchGitChangesetProvider>;
}
