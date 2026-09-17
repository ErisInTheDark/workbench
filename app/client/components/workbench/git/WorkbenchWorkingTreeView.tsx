/* Exports: default WorkbenchWorkingTreeView: compose repository selection, file navigation and sticky diff review. */
"use client";
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { createProjectRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchGitFileList from "./WorkbenchGitFileList";
import WorkbenchGitDiffView from "./WorkbenchGitDiffView";
import WorkbenchGitComposer from "./WorkbenchGitComposer";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchWorkingTreeView() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const projectHref = useWorkbenchProjectNavigation();
  const [filesWidth, setFilesWidth] = useState(280);
  const [mobileDiff, setMobileDiff] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const getViewport = useCallback(() => viewport.current, []);
  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center gap-3 px-3 py-3">
      <a className="rounded-lg px-2 py-1 text-sm hover:bg-accent-soft md:hidden" href={projectHref(createProjectRoute(state.projectId))}
        onClick={event => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          window.history.pushState({ workbench: true }, "", event.currentTarget.href);
        }}>Back to project</a>
      <h1 className="mr-auto text-base font-semibold">Working tree</h1>
      {!mobileDiff ? <button type="button" className="rounded-lg px-2 py-1 text-sm text-accent hover:bg-accent-soft md:hidden"
        onClick={() => setMobileDiff(true)}>Review changes</button> : null}
      {snapshot.data.repositories.length > 1 ? <select aria-label="Git repository" value={snapshot.rootId} disabled={snapshot.busy}
        className="max-w-64 rounded-lg bg-bg px-2 py-1 text-sm" onChange={event => state.selectRoot(event.target.value)}>
        {snapshot.data.repositories.map(repository => <option key={repository.rootId} value={repository.rootId}>{repository.label}</option>)}
      </select> : null}
      <span className="text-xs text-fg/muted">{state.repository?.branch ?? (state.repository?.head ? "Detached HEAD" : "")}</span>
      <button type="button" className="rounded-lg px-2 py-1 text-sm text-fg/muted hover:bg-accent-soft" disabled={snapshot.busy}
        onClick={() => { void state.refresh(); }}>Refresh</button>
    </header>
    {snapshot.status === "loading" || snapshot.status === "idle" ? <p className="px-3 text-sm text-fg/muted">Checking working-tree changes...</p> : null}
    {snapshot.error ? <p role="alert" className="whitespace-pre-line px-3 text-sm text-danger">{snapshot.error}</p> : null}
    {snapshot.operationError ? <p role="alert" className="px-3 text-sm text-danger">{snapshot.operationError}</p> : null}
    {snapshot.result ? <div role="status" className="px-3 text-sm text-fg/muted">
      <p>{snapshot.result.message}</p>
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
        <button type="button" className="rounded-lg px-2 py-2 text-sm hover:bg-accent-soft md:hidden" onClick={() => setMobileDiff(false)}>Back to files</button>
        <div className="grid min-h-full min-w-0 grid-cols-1 grid-rows-[1fr_auto]">
          <div className="col-start-1 row-start-1 min-w-0"><WorkbenchGitDiffView /></div>
          <WorkbenchGitComposer getViewport={getViewport} />
        </div>
      </div>
    </div>
  </div>;
}
