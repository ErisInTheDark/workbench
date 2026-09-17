/* Exports: default WorkbenchGitDiffView: render unified/split selectable diffs and specialised previews. */
"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { describeWorkingTreeDiff, type WorkingTreeDiffRow } from "workbench-shared/workbench/git/working-tree-selection";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";
import WorkbenchGitImageDiff from "./WorkbenchGitImageDiff";
import WorkbenchGitMarkdownDiff from "./WorkbenchGitMarkdownDiff";
import { CheckIcon, CheckCheckIcon } from "../workbench-icons";

const KEYWORDS = new Set("const let var function return if else for while class interface type import export from default async await new throw try catch true false null undefined public private readonly static extends implements def fn pub use struct enum match impl void int string boolean".split(" "));
function code(text: string) {
  return text.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gu).map((token, index) => (
    <span key={index} className={token.startsWith("//") ? "text-fg/muted" : /^["'`]/u.test(token) ? "text-emerald-800 dark:text-emerald-200"
      : KEYWORDS.has(token) ? "text-purple-800 dark:text-purple-200" : /^\d/u.test(token) ? "text-sky-800 dark:text-sky-200" : undefined}>{token}</span>
  ));
}
function changedCode(text: string, other?: string) {
  if (other === undefined || text === other) return code(text || " ");
  let start = 0;
  let end = 0;
  while (start < Math.min(text.length, other.length) && text[start] === other[start]) start++;
  while (end < Math.min(text.length, other.length) - start && text[text.length - end - 1] === other[other.length - end - 1]) end++;
  return <>{code(text.slice(0, start))}<mark className="rounded-sm bg-current/15 text-inherit">{code(text.slice(start, text.length - end))}</mark>{code(text.slice(text.length - end))}</>;
}

export default function WorkbenchGitDiffView() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [mode, setMode] = useState<"unified" | "split" | "markdown">("unified");
  const [whitespace, setWhitespace] = useState(false);
  const drag = useRef<{ start: string; included: boolean; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const file = state.file;
  const model = useMemo(() => describeWorkingTreeDiff(snapshot.diff?.patch ?? ""), [snapshot.diff?.patch]);
  const byId = useMemo(() => new Map(model.rows.map(row => [row.id, row])), [model]);
  const selection = snapshot.selections.find(selection => selection.path === file?.path);
  const selected = new Set(selection ? selection.lineIds ?? model.rows.filter(row => row.selectable).map(row => row.id) : []);
  const image = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/iu.test(file?.path ?? "");
  const markdown = /\.(?:md|markdown|mdown|mkd|mkdn|mdx)$/iu.test(file?.path ?? "");
  const canSelect = Boolean(file?.partial && !file.ownerIds.length && model.complete && !snapshot.busy);
  useEffect(() => {
    if (snapshot.contentStatus === "ready" && (image || (markdown && mode === "markdown"))) void state.loadPreview();
  }, [state, snapshot.contentStatus, file?.identity, image, markdown, mode]);
  useEffect(() => {
    const end = () => {
      dragged.current = Boolean(drag.current?.moved);
      drag.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); drag.current = null; };
  }, [snapshot.rootId, file?.identity]);
  const { visibleRows, byHunk, chunks } = useMemo(() => {
    const visibleRows = model.rows.filter(row => whitespace || !row.whitespaceOnly);
    const byHunk = new Map<number, WorkingTreeDiffRow[]>();
    const chunks = new Map<string, string[]>();
    for (const row of visibleRows) {
      const hunk = byHunk.get(row.hunk) ?? [];
      hunk.push(row);
      byHunk.set(row.hunk, hunk);
      if (row.chunk) {
        const chunk = chunks.get(row.chunk) ?? [];
        chunk.push(row.id);
        chunks.set(row.chunk, chunk);
      }
    }
    return { visibleRows, byHunk, chunks };
  }, [model, whitespace]);
  const enter = (row: WorkingTreeDiffRow) => {
    const current = drag.current;
    if (!current || !row.selectable) return;
    const rows = visibleRows.filter(row => row.selectable);
    const start = rows.findIndex(row => row.id === current.start);
    const end = rows.findIndex(candidate => candidate.id === row.id);
    if (start < 0 || end < 0) return;
    current.moved = current.moved || start !== end;
    state.setLines(rows.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.id), current.included);
  };
  const rowContent = (row: WorkingTreeDiffRow | undefined, side?: "old" | "new") => {
    if (!row) return <div className="min-w-0" />;
    const tone = row.type === "addition" ? "bg-emerald-500/10" : row.type === "deletion" ? "bg-red-500/10" : "";
    return <div className={`flex min-w-0 items-stretch ${tone}`} onPointerEnter={() => enter(row)}>
      <span className="flex w-14 shrink-0 items-start justify-center gap-1">
        {row.selectable ? <>
          <button type="button" role="checkbox" aria-checked={selected.has(row.id)}
            aria-label={`Include ${row.type} at line ${row.oldLineNumber ?? row.newLineNumber}`}
            disabled={!canSelect} className="flex min-h-7 w-6 touch-none items-center justify-center rounded text-accent hover:bg-accent-soft disabled:opacity-30"
            onPointerDown={event => {
              if (event.button !== 0 || !canSelect) return;
              dragged.current = false;
              drag.current = { start: row.id, included: !selected.has(row.id), moved: false };
            }}
            onClick={() => { if (!dragged.current) state.setLines([row.id], !selected.has(row.id)); dragged.current = false; }}>
            {selected.has(row.id) ? <CheckIcon size={14} /> : <span className="block size-3 rounded-sm ring-1 ring-inset ring-current/40" />}
          </button>
          {row.chunk && chunks.get(row.chunk)?.[0] === row.id ? <button type="button"
            aria-label="Toggle change chunk" title="Toggle change chunk" disabled={!canSelect}
            className="flex min-h-7 w-6 items-center justify-center rounded text-accent hover:bg-accent-soft disabled:opacity-30"
            onClick={() => {
              const ids = chunks.get(row.chunk!) ?? [];
              state.setLines(ids, !ids.every(id => selected.has(id)));
            }}><CheckCheckIcon size={14} /></button> : null}
        </> : null}
      </span>
      <span className="w-12 shrink-0 select-none px-1 py-1 text-right text-fg/muted">{side === "new" ? row.newLineNumber : row.oldLineNumber}</span>
      {!side ? <span className="w-12 shrink-0 select-none px-1 py-1 text-right text-fg/muted">{row.newLineNumber}</span> : null}
      <span className="w-5 shrink-0 select-none py-1 text-center text-fg/muted">{row.type === "addition" ? "+" : row.type === "deletion" ? "−" : " "}</span>
      <code className="min-w-0 flex-1 whitespace-pre px-2 py-1">
        {changedCode(row.text, row.pairId ? byId.get(row.pairId)?.text : undefined)}
        {row.noNewline ? <span className="ml-3 text-fg/muted">[no final newline]</span> : null}
      </code>
    </div>;
  };
  return <section className="min-w-0">
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-bg/90 px-2 py-2 text-xs backdrop-blur">
      <span className="mr-auto min-w-0 truncate text-sm" title={file?.path}>{file?.path ?? "Changes"}</span>
      {!image ? <>
        <label className="flex items-center gap-1">View
          <select aria-label="Diff layout" value={markdown ? mode : mode === "markdown" ? "unified" : mode}
            className="rounded bg-bg p-1" onChange={event => setMode(event.target.value as typeof mode)}>
            <option value="unified">Unified</option><option value="split">Split</option>
            {markdown ? <option value="markdown">Markdown</option> : null}
          </select>
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={whitespace} onChange={event => setWhitespace(event.target.checked)} />Whitespace changes</label>
      </> : null}
    </div>
    {file?.ownerIds.length ? <p className="px-3 text-sm text-fg/muted">Claimed changes are inspect-only. Open the owning thread to act on them.</p> : null}
    {snapshot.contentError ? <div role="alert" className="p-3 text-sm text-danger">{snapshot.contentError}
      <button type="button" className="ml-2 rounded px-2 py-1 hover:bg-accent-soft" onClick={() => void state.loadContent()}>Retry</button></div> : null}
    {image ? <WorkbenchGitImageDiff key={`${snapshot.rootId}:${file?.path}`} /> : markdown && mode === "markdown" ? <WorkbenchGitMarkdownDiff /> :
      snapshot.contentStatus === "loading" ? <p className="p-4 text-sm text-fg/muted">Loading diff...</p> :
      snapshot.diff?.unavailable ? <p className="p-4 text-sm text-fg/muted">{snapshot.diff.unavailable}</p> :
      !file ? <p className="p-4 text-sm text-fg/muted">Select a file to inspect its changes.</p> :
      !visibleRows.length ? <p className="p-4 text-sm text-fg/muted">{model.rows.length ? "Only whitespace changes. Enable whitespace changes to inspect them." : "No text changes. Metadata changes can be selected as a whole file."}</p> :
      <div className="explorer-scrollbar overflow-x-auto pb-4 font-mono text-xs leading-5">
        {model.hunks.map((hunk, index) => {
          const rows = byHunk.get(index);
          if (!rows?.length) return null;
          return <div key={index} className="min-w-max" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}>
            <div className="px-3 py-2 text-accent">{hunk.header}</div>
            {rows.map(row => mode === "split" ? (
              row.type === "addition" && row.pairId ? null :
                <div key={row.id} className="grid grid-cols-2">
                  {rowContent(row.type === "addition" ? undefined : row, "old")}
                  {rowContent(row.type === "context" || row.type === "addition" ? row : row.pairId ? byId.get(row.pairId) : undefined, "new")}
                </div>
            ) : <Fragment key={row.id}>{rowContent(row)}</Fragment>)}
          </div>;
        })}
      </div>}
  </section>;
}
