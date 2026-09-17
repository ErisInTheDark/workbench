/* Exports: default WorkbenchGitDiffView: coordinate shared diff controls, loading and specialised previews. */
"use client";
import { useEffect, useState } from "react";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";
import WorkbenchGitImageDiff from "./WorkbenchGitImageDiff";
import WorkbenchGitMarkdownDiff from "./WorkbenchGitMarkdownDiff";
import WorkbenchGitTextDiff from "./WorkbenchGitTextDiff";
import WorkbenchModeRow from "../WorkbenchModeRow";
import WorkbenchIconButton from "../WorkbenchIconButton";
import { RefreshCwIcon } from "../workbench-icons";

export default function WorkbenchGitDiffView() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [mode, setMode] = useState<"unified" | "split" | "markdown">("unified");
  const [whitespace, setWhitespace] = useState(false);
  const file = state.file;
  const image = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/iu.test(file?.path ?? "");
  const markdown = /\.(?:md|markdown|mdown|mkd|mkdn|mdx)$/iu.test(file?.path ?? "");
  const effectiveMode = !markdown && mode === "markdown" ? "unified" : mode;
  useEffect(() => {
    if (snapshot.contentStatus === "ready" && !snapshot.contentError && (image || (markdown && mode === "markdown"))) void state.loadPreview();
  }, [state, snapshot.contentStatus, snapshot.contentError, file?.identity, image, markdown, mode]);
  const loading = snapshot.contentStatus === "loading" || (snapshot.contentStatus === "ready" && !snapshot.preview && !snapshot.contentError && (image || effectiveMode === "markdown"));
  return <section className="min-w-0" aria-busy={loading}>
    <div className="sticky top-0 z-10 flex flex-col gap-2 pb-3 text-sm">
      <span className="pointer-events-none absolute -inset-x-2 inset-y-0 -z-10 bg-[linear-gradient(to_bottom,var(--shell-fade-bg)_70%,transparent)]" aria-hidden="true" />
      <span className="min-w-0 truncate text-fg/muted" title={file?.path}>{file?.path ?? "Changes"}</span>
      {!image ? <div className="flex flex-wrap items-center justify-between gap-2">
        <WorkbenchModeRow ariaLabel="Diff layout" value={effectiveMode} onChange={setMode} options={[
          { value: "unified", label: "Unified", ariaLabel: "Unified diff", icon: null },
          { value: "split", label: "Split", ariaLabel: "Split diff", icon: null },
          ...(markdown ? [{ value: "markdown" as const, label: "Markdown", ariaLabel: "Markdown diff", icon: null }] : []),
        ]} />
        {effectiveMode !== "markdown" ? <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg/muted">Whitespace changes</span>
          <WorkbenchModeRow ariaLabel="Whitespace changes" value={whitespace ? "shown" : "hidden"}
            onChange={value => setWhitespace(value === "shown")} options={[
              { value: "hidden", label: "Hidden", ariaLabel: "Hide whitespace changes", icon: null },
              { value: "shown", label: "Shown", ariaLabel: "Show whitespace changes", icon: null },
            ]} />
        </span> : null}
      </div> : null}
    </div>
    {file?.ownerIds.length ? <p className="mb-3 text-sm text-fg/muted">Claimed changes are inspect-only. Open the owning thread to act on them.</p> : null}
    {snapshot.contentError ? <div role="alert" className="py-3 text-sm text-danger">{snapshot.contentError}
      <WorkbenchIconButton label="Retry diff" onClick={() => { void state.loadContent(); }}><RefreshCwIcon size={16} /></WorkbenchIconButton>
    </div> : null}
    {loading ? <div role="status" aria-label="Loading diff" className="space-y-3 py-3">
      {Array.from({ length: 10 }, (_, index) => <div key={index} className="flex gap-4" aria-hidden="true">
        <span className="h-3 w-16 shrink-0 rounded workbench-skeleton" />
        <span className="h-3 rounded workbench-skeleton" style={{ width: `${[62, 78, 45, 70, 36][index % 5]}%` }} />
      </div>)}
    </div> : !file ? <p className="py-4 text-sm text-fg/muted">Select a file to inspect its changes.</p>
      : image ? <WorkbenchGitImageDiff key={`${snapshot.rootId}:${file.path}`} />
      : effectiveMode === "markdown" ? <WorkbenchGitMarkdownDiff />
      : snapshot.diff?.unavailable ? <p className="py-4 text-sm text-fg/muted">{snapshot.diff.unavailable}</p>
      : snapshot.diff ? <WorkbenchGitTextDiff key={`${snapshot.rootId}:${file.identity}:${effectiveMode}:${whitespace}`} mode={effectiveMode} whitespace={whitespace} />
      : null}
  </section>;
}
