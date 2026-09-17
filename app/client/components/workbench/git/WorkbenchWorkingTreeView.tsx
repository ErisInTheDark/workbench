/* Exports: default WorkbenchWorkingTreeView: compose file navigation and sticky diff review beneath the shell header. */
"use client";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import PrimaryButton from "../PrimaryButton";
import { BackArrowIcon, OpenThreadIcon } from "../workbench-icons";
import WorkbenchGitComposer from "./WorkbenchGitComposer";
import WorkbenchGitDiffView from "./WorkbenchGitDiffView";
import WorkbenchGitFileList from "./WorkbenchGitFileList";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchWorkingTreeView () {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [filesWidth, setFilesWidth] = useState(280);
  const [mobileDiff, setMobileDiff] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const getViewport = useCallback(() => viewport.current, []);
  if (!snapshot.data.repositories.length && (snapshot.status === "error" || snapshot.status === "unavailable")) {
    return <div className="flex h-full min-h-0 flex-col items-start gap-3 py-4">
      <p role="alert" className="whitespace-pre-line text-sm text-danger">{snapshot.error}</p>
      <PrimaryButton disabled={snapshot.refreshing} onClick={() => { void state.refresh(); }}>Retry working tree</PrimaryButton>
    </div>;
  }
  if (snapshot.initialising) return <div aria-label="Loading working tree" aria-busy="true"
    className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[280px_minmax(0,1fr)]">
    <div aria-hidden="true" className="space-y-5 py-3">
      <div className="h-5 w-32 rounded workbench-skeleton" />
      {Array.from({ length: 7 }, (_, index) => <div key={index} className="space-y-2">
        <div className="h-4 w-4/5 rounded workbench-skeleton" />
        <div className="ml-6 h-3 w-1/2 rounded workbench-skeleton" />
      </div>)}
    </div>
    <div aria-hidden="true" className="hidden min-h-0 flex-col gap-5 py-3 md:flex">
      <div className="h-5 w-2/5 rounded workbench-skeleton" />
      <div className="min-h-0 flex-1 space-y-3 overflow-hidden">
        {Array.from({ length: 14 }, (_, index) => <div key={index} className="h-4 w-4/5 rounded workbench-skeleton" />)}
      </div>
      <div className="h-24 shrink-0 rounded-2xl workbench-skeleton" />
    </div>
  </div>;
  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    {snapshot.error ? <p role="alert" className="whitespace-pre-line px-3 text-sm text-danger">{snapshot.error}</p> : null}
    {snapshot.operationError ? <p role="alert" className="px-3 text-sm text-danger">{snapshot.operationError}</p> : null}
    {snapshot.result ? <div role="status" className="px-3 text-sm text-fg/muted">
      {snapshot.result.stash ? <p>Saved stash <code>{snapshot.result.stash.slice(0, 12)}</code>. It is available through Git.</p> : null}
      {snapshot.result.warnings.map((warning, index) => <p key={index} className="text-danger">{warning}</p>)}
    </div> : null}
    {snapshot.status === "ready" && !snapshot.data.repositories.length && !snapshot.data.errors.length ? <p className="px-3 text-sm text-fg/muted">This project has no Git repositories.</p> : null}
    <div ref={split} className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[var(--git-file-width)_0.35rem_minmax(0,1fr)]"
      style={{ "--git-file-width": `${filesWidth}px` } as CSSProperties}>
      <aside aria-label="Changed files" className={`
        min-h-0 min-w-0 flex-col pb-3 md:flex
        ${mobileDiff ? "hidden" : "flex"}
      `}>
        <PrimaryButton className="mb-2 self-end md:hidden" onClick={() => setMobileDiff(true)}>
          Review changes <OpenThreadIcon size={16} />
        </PrimaryButton>
        <WorkbenchGitFileList onSelect={() => setMobileDiff(true)} />
      </aside>
      <div role="separator" aria-label="Resize changed files" aria-orientation="vertical" aria-valuenow={filesWidth}
        tabIndex={0} className="hidden cursor-col-resize touch-none rounded hover:bg-accent-soft focus:bg-accent-soft md:block"
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setFilesWidth(width => Math.max(180, Math.min(600, width + (event.key === "ArrowRight" ? 20 : -20))));
        }}
        onPointerDown={event => {
          if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }
        }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = split.current?.getBoundingClientRect();
          if (bounds) setFilesWidth(Math.max(180, Math.min(600, bounds.width - 240, event.clientX - bounds.left)));
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <div ref={viewport} className={`
        explorer-scrollbar min-h-0 min-w-0 overflow-y-auto px-2 pb-3 md:block
        ${mobileDiff ? "block" : "hidden"}
      `}>
        <PrimaryButton className="mb-2 md:hidden" onClick={() => setMobileDiff(false)}><BackArrowIcon size={16} />Back to files</PrimaryButton>
        <div className="grid min-h-full min-w-0 grid-cols-1 grid-rows-[1fr_auto]">
          <div className="col-start-1 row-start-1 min-w-0"><WorkbenchGitDiffView /></div>
          <WorkbenchGitComposer getViewport={getViewport} />
        </div>
      </div>
    </div>
  </div>;
}
