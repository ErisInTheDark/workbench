/* Exports: default WorkbenchGitTextDiff: render selectable line-number gutters and continuous chunk strips. */
"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { describeWorkingTreeDiff, type WorkingTreeDiffRow } from "workbench-shared/workbench/git/working-tree-selection";
import { beginDiffGesture, finishDiffGesture, moveDiffGesture, type WorkingTreeDiffGesture } from "../../../workbench/git/working-tree-diff-gesture";
import { CheckIcon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

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
type DisplayRow = { row: WorkingTreeDiffRow; before?: WorkingTreeDiffRow; after?: WorkingTreeDiffRow; ids: string[]; group: number };

export default function WorkbenchGitTextDiff({ mode, whitespace }: { mode: "unified" | "split"; whitespace: boolean }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [gesture, setGesture] = useState<WorkingTreeDiffGesture | null>(null);
  const [hoveredChunk, setHoveredChunk] = useState<string | null>(null);
  const file = state.file;
  const model = useMemo(() => describeWorkingTreeDiff(snapshot.diff?.patch ?? ""), [snapshot.diff?.patch]);
  const byId = useMemo(() => new Map(model.rows.map(row => [row.id, row])), [model]);
  const display = useMemo(() => {
    const groups: string[][] = [];
    const hunks = new Map<number, DisplayRow[]>();
    for (const row of model.rows) {
      if ((!whitespace && row.whitespaceOnly) || (mode === "split" && row.type === "addition" && row.pairId)) continue;
      const pair = row.pairId ? byId.get(row.pairId) : undefined;
      const ids = row.selectable ? mode === "split" && pair ? [row.id, pair.id] : [row.id] : [];
      const group = ids.length ? groups.push(ids) - 1 : -1;
      const rows = hunks.get(row.hunk) ?? [];
      rows.push({
        row, ids, group,
        before: row.type === "addition" ? undefined : row,
        after: row.type === "deletion" ? pair : row,
      });
      hunks.set(row.hunk, rows);
    }
    return { groups, hunks };
  }, [byId, mode, model, whitespace]);
  const selection = snapshot.selections.find(selection => selection.path === file?.path);
  const selected = new Set(selection ? selection.lineIds ?? model.rows.filter(row => row.selectable).map(row => row.id) : []);
  const canSelect = Boolean(file?.partial && !file.ownerIds.length && model.complete && !snapshot.busy);
  const preview = gesture ? finishDiffGesture(gesture, gesture.pointerId) : null;
  if (preview) for (const id of preview.ids) { if (preview.included) selected.add(id); else selected.delete(id); }

  useEffect(() => {
    if (!gesture) return;
    if (!canSelect) { setGesture(null); return; }
    const move = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-diff-group]");
      if (!target || target.dataset.diffIdentity !== file?.identity) return;
      const group = Number(target.dataset.diffGroup);
      setGesture(current => current ? moveDiffGesture(current, event.pointerId, group) : null);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== gesture.pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-diff-group]");
      const releaseGroup = target?.dataset.diffIdentity === file?.identity ? Number(target?.dataset.diffGroup) : undefined;
      const result = finishDiffGesture(gesture, event.pointerId, event.type === "pointercancel", releaseGroup);
      if (result) state.setLines(result.ids, result.included);
      setGesture(null);
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") setGesture(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", cancel);
    };
  }, [canSelect, file?.identity, gesture, state]);

  if (!display.hunks.size) return <p className="px-2 py-4 text-sm text-fg/muted">{model.rows.length
    ? "Only whitespace changes. Show whitespace changes to inspect them."
    : "No text changes. Metadata changes can be selected as a whole file."}</p>;

  const numbers = (item: DisplayRow, side?: "old" | "new") => {
    const any = item.ids.some(id => selected.has(id));
    const all = item.ids.length > 0 && item.ids.every(id => selected.has(id));
    const content = <>
      <span className="inline-flex w-4 shrink-0 items-center justify-center">
        {all ? <CheckIcon size={14} /> : any ? <span className="w-2.5 border-t-2 border-current" /> : null}
      </span>
      {side !== "new" ? <span className="w-10 text-right">{item.before?.oldLineNumber}</span> : null}
      {side !== "old" ? <span className="w-10 text-right">{mode === "unified" ? item.row.newLineNumber : item.after?.newLineNumber}</span> : null}
    </>;
    const className = `
      flex select-none items-center justify-end gap-1 px-2 py-0.5 tabular-nums
      ${any ? "bg-accent text-bg" : "text-fg/muted"}
      ${canSelect && item.ids.length ? "cursor-pointer touch-none hover:bg-accent-soft hover:text-text focus-visible:outline-2 focus-visible:outline-accent" : ""}
    `;
    return item.ids.length && canSelect ? <button type="button" role="checkbox"
      aria-checked={all ? true : any ? "mixed" : false}
      aria-label={`Include change at line ${item.before?.oldLineNumber ?? item.after?.newLineNumber}`}
      className={className} data-diff-group={item.group} data-diff-identity={file?.identity}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setGesture(beginDiffGesture(event.pointerId, display.groups, item.group, !any));
      }}
      onClick={event => { if (event.detail === 0) state.setLines(item.ids, !any); }}>{content}</button>
      : <span className={className}>{content}</span>;
  };
  const text = (row: WorkingTreeDiffRow | undefined, chunk: string | null) => <code className={`
    min-w-0 whitespace-pre px-2 py-0.5
    ${row?.type === "addition" ? "bg-emerald-500/10" : row?.type === "deletion" ? "bg-red-500/10" : ""}
    ${chunk && hoveredChunk === chunk ? "brightness-110" : ""}
  `}>{row ? <><span className="mr-2 select-none text-fg/muted">{row.type === "addition" ? "+" : row.type === "deletion" ? "-" : " "}</span>
    {changedCode(row.text, row.pairId ? byId.get(row.pairId)?.text : undefined)}
    {row.noNewline ? <span className="ml-3 text-fg/muted">[no final newline]</span> : null}
  </> : " "}</code>;

  const chunkControl = (rows: DisplayRow[], item: DisplayRow, index: number) => {
    const chunk = item.row.chunk;
    if (!chunk) return <span style={{ gridColumn: 1, gridRow: index + 1 }} />;
    if (rows[index - 1]?.row.chunk === chunk) return null;
    const next = rows.slice(index).findIndex(row => row.row.chunk !== chunk);
    const span = next < 0 ? rows.length - index : next;
    const ids = rows.slice(index, index + span).flatMap(row => row.ids);
    const any = ids.some(id => selected.has(id));
    const all = ids.length > 0 && ids.every(id => selected.has(id));
    return <button type="button" role="checkbox" aria-checked={all ? true : any ? "mixed" : false}
      aria-label={`Include change chunk at line ${item.row.oldLineNumber ?? item.row.newLineNumber}`}
      disabled={!canSelect} title={any ? "Exclude chunk" : "Include chunk"}
      style={{ gridColumn: 1, gridRow: `${index + 1} / span ${span}` }}
      className={`
        flex items-start justify-center pt-1 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default
        ${any ? "bg-accent text-bg" : "text-fg/muted"}
        ${canSelect ? "cursor-pointer hover:bg-accent-soft hover:text-text" : ""}
      `}
      onPointerEnter={() => setHoveredChunk(chunk)} onPointerLeave={() => setHoveredChunk(null)}
      onFocus={() => setHoveredChunk(chunk)} onBlur={() => setHoveredChunk(null)}
      onClick={() => state.setLines(ids, !any)}>
      {all ? <CheckIcon size={14} /> : any ? <span className="mt-1.5 w-2.5 border-t-2 border-current" /> : null}
    </button>;
  };
  if (mode === "split") return <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)] pb-4 font-mono text-xs leading-5">
    <div aria-label="Change chunks">
      {model.hunks.map((_hunk, hunkIndex) => {
        const rows = display.hunks.get(hunkIndex);
        return rows?.length ? <Fragment key={hunkIndex}>
          <div className="h-8" />
          <div className="grid auto-rows-[1.5rem]">{rows.map((item, index) => <Fragment key={item.row.id}>{chunkControl(rows, item, index)}</Fragment>)}</div>
        </Fragment> : null;
      })}
    </div>
    {(["old", "new"] as const).map(side => <div key={side} className="explorer-scrollbar min-w-0 overflow-x-auto" aria-label={side === "old" ? "Before changes" : "After changes"}>
      <div className="w-max min-w-full">
        {model.hunks.map((hunk, hunkIndex) => {
          const rows = display.hunks.get(hunkIndex);
          return rows?.length ? <Fragment key={hunkIndex}>
            <div className="flex h-8 items-center whitespace-nowrap px-2 text-fg/muted">{hunk.header}</div>
            <div className="grid auto-rows-[1.5rem] grid-cols-[auto_minmax(0,1fr)]">
              {rows.map(item => <div className="contents" key={item.row.id} data-diff-group={item.group} data-diff-identity={file?.identity}>
                {numbers(item, side)}{text(side === "old" ? item.before : item.after, item.row.chunk)}
              </div>)}
            </div>
          </Fragment> : null;
        })}
      </div>
    </div>)}
  </div>;

  return <div className="explorer-scrollbar overflow-x-auto pb-4 font-mono text-xs leading-5">
    {model.hunks.map((hunk, hunkIndex) => {
      const rows = display.hunks.get(hunkIndex);
      if (!rows?.length) return null;
      return <div key={hunkIndex} className="min-w-max">
        <div className="px-2 py-2 text-fg/muted">{hunk.header}</div>
        <div className="grid grid-cols-[1.5rem_auto_minmax(0,1fr)]">
          {rows.map((item, index) => <Fragment key={item.row.id}>
              {chunkControl(rows, item, index)}
              <div className="contents" data-diff-group={item.group} data-diff-identity={file?.identity}>
                {numbers(item)}
                {text(item.row, item.row.chunk)}
              </div>
            </Fragment>)}
        </div>
      </div>;
    })}
  </div>;
}
