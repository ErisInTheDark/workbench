/*
 * Exports:
 * - default WorkbenchDiffLines: the one diff renderer for git reviews and thread diffs: unified or split rows with syntax and
 *   in-line change marks, long diffs mounted progressively, and an optional line and chunk picking gutter.
 * - WorkbenchDiffSelection: the picked lines a review shows and edits.
 */
"use client";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { WorkingTreeDiffModel, WorkingTreeDiffRow } from "workbench-shared/workbench/git/working-tree-selection";
import { beginDiffGesture, finishDiffGesture, moveDiffGesture, type WorkingTreeDiffGesture } from "../../../workbench/git/working-tree-diff-gesture";
import { CheckIcon } from "../workbench-icons";

export interface WorkbenchDiffSelection {
  selected: ReadonlySet<string>;
  /** Lines can be picked right now. */
  enabled: boolean;
  setLines(ids: readonly string[], included: boolean): void;
}

/** `review` fills its pane; `thread` bleeds to the transcript edges with faded rows; `framed` sits inside a preview frame. */
type Surface = "review" | "thread" | "framed";
type Mode = "unified" | "split";
type Side = "old" | "new";
/** How much of a line or chunk is picked. */
type Picked = "none" | "some" | "all";

const KEYWORDS = new Set("const let var function return if else for while class interface type import export from default async await new throw try catch true false null undefined public private readonly static extends implements def fn pub use struct enum match impl void int string boolean".split(" "));
const TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gu;
/** Rows mounted at first, so opening a file paints at once. */
const FIRST_ROWS = 300;
/** Rows added each time the end of the mounted diff nears the viewport. */
const MORE_ROWS = 1_000;
const ROW_TINT = {
  addition: "color-mix(in srgb, var(--success) 10%, transparent)",
  deletion: "color-mix(in srgb, var(--danger) 10%, transparent)",
} as const;
const EDGE = 80;
/** Like gitman: picked line numbers fill with a gradient, picked chunk strips with the solid colour. */
const PICKED_LINE = "bg-accent-shift text-canvas";
const PICKED_CHUNK = "bg-accent-vivid text-canvas";

function tokenClass(token: string) {
  if (token.startsWith("//")) return "text-fg/muted";
  if (/^["'`]/u.test(token)) return "text-emerald-800 dark:text-emerald-200";
  if (KEYWORDS.has(token)) return "text-purple-800 dark:text-purple-200";
  if (/^\d/u.test(token)) return "text-sky-800 dark:text-sky-200";
  return null;
}

/** Coloured tokens get a span; plain runs stay text, so a line costs a handful of nodes rather than one per word. */
function code(text: string) {
  const parts: ReactNode[] = [];
  let plain = "";
  for (const token of text.split(TOKEN)) {
    const className = tokenClass(token);
    if (!className) { plain += token; continue; }
    if (plain) parts.push(plain);
    plain = "";
    parts.push(<span key={parts.length} className={className}>{token}</span>);
  }
  if (plain) parts.push(plain);
  return parts;
}

function changedCode(text: string, other?: string) {
  if (other === undefined || text === other) return code(text || " ");
  let start = 0;
  let end = 0;
  while (start < Math.min(text.length, other.length) && text[start] === other[start]) start++;
  while (end < Math.min(text.length, other.length) - start && text[text.length - end - 1] === other[other.length - end - 1]) end++;
  return <>{code(text.slice(0, start))}<mark className="rounded-sm bg-current/15 text-inherit">{code(text.slice(start, text.length - end))}</mark>{code(text.slice(text.length - end))}</>;
}

/** Thread rows fade their tint into the transcript margins instead of ending in a hard edge. */
function rowStyle(row: WorkingTreeDiffRow | undefined, surface: Surface): CSSProperties | undefined {
  if (!row || row.type === "context") return undefined;
  const tint = ROW_TINT[row.type as keyof typeof ROW_TINT];
  if (!tint) return undefined;
  return surface === "thread"
    ? { background: `linear-gradient(to right, transparent 0, ${tint} ${EDGE}px, ${tint} calc(100% - ${EDGE}px), transparent 100%)` }
    : { background: tint };
}

function pickedOf(ids: readonly string[], selected: ReadonlySet<string>): Picked {
  let count = 0;
  for (const id of ids) if (selected.has(id)) count++;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
}

type DisplayRow = {
  row: WorkingTreeDiffRow; before?: WorkingTreeDiffRow; after?: WorkingTreeDiffRow;
  /** The other half of a changed line, for in-line marks. */
  beforePair?: string; afterPair?: string; rowPair?: string;
  ids: string[]; group: number;
};
/** A run of rows sharing one chunk (or none), drawn as one gutter control spanning them. */
type Segment = { chunk: string | null; start: number; span: number; ids: string[]; line: number | null };
type Hunk = { rows: DisplayRow[]; segments: Segment[] };
/** Line picking, read through a ref so memoized rows keep one handler for the diff's whole life. */
type Picker = { begin(event: PointerEvent<HTMLElement>, item: DisplayRow, picked: Picked): void; toggle(ids: readonly string[], picked: Picked): void };

function segmentsOf(rows: readonly DisplayRow[]) {
  const segments: Segment[] = [];
  rows.forEach((item, index) => {
    const last = segments.at(-1);
    if (last && last.chunk === item.row.chunk) {
      last.span++;
      last.ids.push(...item.ids);
    } else {
      segments.push({ chunk: item.row.chunk, start: index, span: 1, ids: [...item.ids], line: item.row.oldLineNumber ?? item.row.newLineNumber });
    }
  });
  return segments;
}

const Text = memo(function Text({ row, pair, surface, hovered }: {
  row: WorkingTreeDiffRow | undefined; pair: string | undefined; surface: Surface; hovered: boolean;
}) {
  const content = useMemo(() => row ? changedCode(row.text, pair) : null, [pair, row]);
  return <code className={`
    min-w-0 whitespace-pre px-2 py-0.5
    ${hovered ? "brightness-110" : ""}
  `} style={rowStyle(row, surface)}>{row ? <><span className="mr-2 select-none text-fg/muted">{row.type === "addition" ? "+" : row.type === "deletion" ? "-" : " "}</span>
    {content}
    {row.noNewline ? <span role="img" aria-label="No final newline" className="ml-3 select-none text-fg/muted">⏎̸</span> : null}
  </> : " "}</code>;
});

const Line = memo(function Line({ item, side, mode, surface, identity, gutter, pickable, picked, hovered, picker }: {
  item: DisplayRow; side?: Side; mode: Mode; surface: Surface; identity: string;
  gutter: boolean; pickable: boolean; picked: Picked; hovered: boolean; picker: { current: Picker };
}) {
  const shown = side === "old" ? item.before : side === "new" ? item.after : item.row;
  const tone = shown?.type === "addition" ? "text-[color:color-mix(in_srgb,var(--success)_70%,var(--text)_30%)]"
    : shown?.type === "deletion" ? "text-[color:color-mix(in_srgb,var(--danger)_70%,var(--text)_30%)]" : "text-fg/muted";
  const content = <>
    {gutter ? <span className="inline-flex w-4 shrink-0 items-center justify-center">
      {picked === "all" ? <CheckIcon size={14} /> : picked === "some" ? <span className="w-2.5 border-t-2 border-current" /> : null}
    </span> : null}
    {side !== "new" ? <span className="w-10 text-right">{item.before?.oldLineNumber}</span> : null}
    {side !== "old" ? <span className="w-10 text-right">{mode === "unified" ? item.row.newLineNumber : item.after?.newLineNumber}</span> : null}
  </>;
  // Picked lines fill their number cell like gitman's staged lines; pickable ones carry their change tint until picked.
  const className = `
    flex select-none items-center justify-end gap-1 px-2 py-0.5 tabular-nums transition-colors duration-100
    ${picked !== "none" ? PICKED_LINE : hovered ? "bg-accent/30 text-text" : pickable ? `${tone} hover:bg-accent/25 hover:text-text` : tone}
    ${pickable ? "cursor-pointer touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent" : ""}
  `;
  const numbers = pickable ? <button type="button" role="checkbox"
    aria-checked={picked === "all" ? true : picked === "some" ? "mixed" : false}
    aria-label={`Include change at line ${item.before?.oldLineNumber ?? item.after?.newLineNumber}`}
    className={className} style={picked === "none" && !hovered ? rowStyle(shown, "review") : undefined}
    onPointerDown={event => picker.current.begin(event, item, picked)}
    onClick={event => { if (event.detail === 0) picker.current.toggle(item.ids, picked); }}>{content}</button>
    : <span className={className}>{content}</span>;
  const pair = side === "old" ? item.beforePair : side === "new" ? item.afterPair : item.rowPair;
  return <div className="contents" data-diff-group={item.group} data-diff-identity={identity}>
    {numbers}
    <Text row={shown} pair={pair} surface={surface} hovered={hovered} />
  </div>;
});

const ChunkControl = memo(function ChunkControl({ segment, pickable, picked, onHover, picker }: {
  segment: Segment; pickable: boolean; picked: Picked; onHover(chunk: string | null): void; picker: { current: Picker };
}) {
  const style = { gridColumn: 1, gridRow: `${segment.start + 1} / span ${segment.span}` };
  if (!segment.chunk || !pickable) return <span aria-hidden="true" style={style} className={segment.chunk && picked !== "none" ? "bg-accent/30" : ""} />;
  const chunk = segment.chunk;
  return <button type="button" role="checkbox" aria-checked={picked === "all" ? true : picked === "some" ? "mixed" : false}
    aria-label={`Include change chunk at line ${segment.line}`}
    style={style}
    className={`
      flex cursor-pointer items-start justify-center pt-1 transition-colors duration-100
      focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent
      ${picked !== "none" ? PICKED_CHUNK : "text-fg/muted hover:bg-accent/30 hover:text-text"}
    `}
    onPointerEnter={() => onHover(chunk)} onPointerLeave={() => onHover(null)}
    onFocus={() => onHover(chunk)} onBlur={() => onHover(null)}
    onClick={() => picker.current.toggle(segment.ids, picked)}>
    {picked === "all" ? <CheckIcon size={14} /> : picked === "some" ? <span className="mt-1.5 w-2.5 border-t-2 border-current" /> : null}
  </button>;
});

export default function WorkbenchDiffLines({ model, mode = "unified", whitespace = true, identity, selection, surface = "review", onShowWhitespace }: {
  model: WorkingTreeDiffModel;
  mode?: Mode;
  whitespace?: boolean;
  /** Distinguishes this diff's rows from any other diff a pointer gesture could cross. */
  identity: string;
  selection?: WorkbenchDiffSelection;
  surface?: Surface;
  onShowWhitespace?(): void;
}) {
  const [gesture, setGesture] = useState<WorkingTreeDiffGesture | null>(null);
  const [hoveredChunk, setHoveredChunk] = useState<string | null>(null);
  const [budget, setBudget] = useState(FIRST_ROWS);
  const more = useRef<HTMLDivElement>(null);
  const display = useMemo(() => {
    const byId = new Map(model.rows.map(row => [row.id, row]));
    const groups: string[][] = [];
    const rowsByHunk = new Map<number, DisplayRow[]>();
    for (const row of model.rows) {
      if ((!whitespace && row.whitespaceOnly) || (mode === "split" && row.type === "addition" && row.pairId)) continue;
      const pair = row.pairId ? byId.get(row.pairId) : undefined;
      const ids = row.selectable ? mode === "split" && pair ? [row.id, pair.id] : [row.id] : [];
      const group = ids.length ? groups.push(ids) - 1 : -1;
      const before = row.type === "addition" ? undefined : row;
      const after = row.type === "deletion" ? pair : row;
      const rows = rowsByHunk.get(row.hunk) ?? [];
      rows.push({
        row, ids, group, before, after, rowPair: pair?.text,
        beforePair: before?.pairId ? byId.get(before.pairId)?.text : undefined,
        afterPair: after?.pairId ? byId.get(after.pairId)?.text : undefined,
      });
      rowsByHunk.set(row.hunk, rows);
    }
    const hunks = new Map<number, Hunk>([...rowsByHunk].map(([index, rows]) => [index, { rows, segments: segmentsOf(rows) }]));
    return { groups, hunks };
  }, [mode, model, whitespace]);
  /** How many rows of each hunk are mounted; the last mounted hunk may be cut short, its chunk strips clipped to match. */
  const mounted = useMemo(() => {
    const shown = new Map<number, Hunk>();
    let left = budget;
    for (const [index, hunk] of display.hunks) {
      if (left <= 0) break;
      const count = Math.min(left, hunk.rows.length);
      left -= count;
      shown.set(index, count === hunk.rows.length ? hunk : {
        rows: hunk.rows.slice(0, count),
        segments: hunk.segments.filter(segment => segment.start < count)
          .map(segment => segment.start + segment.span <= count ? segment : { ...segment, span: count - segment.start }),
      });
    }
    return shown;
  }, [budget, display]);
  const total = useMemo(() => [...display.hunks.values()].reduce((sum, hunk) => sum + hunk.rows.length, 0), [display]);
  const pending = budget < total;
  useEffect(() => {
    const element = more.current;
    if (!element || !pending) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setBudget(current => current + MORE_ROWS);
    }, { rootMargin: "1200px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pending, mounted]);
  const canSelect = Boolean(selection?.enabled && model.complete);
  const setLines = selection?.setLines;
  const selected = useMemo(() => {
    const preview = gesture ? finishDiffGesture(gesture, gesture.pointerId) : null;
    if (!preview) return selection?.selected ?? new Set<string>();
    const next = new Set(selection?.selected);
    for (const id of preview.ids) { if (preview.included) next.add(id); else next.delete(id); }
    return next;
  }, [gesture, selection?.selected]);

  const picker = useRef<Picker>(null!);
  picker.current = {
    begin: (event, item, picked) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      setGesture(beginDiffGesture(event.pointerId, display.groups, item.group, picked === "none"));
    },
    toggle: (ids, picked) => setLines?.(ids, picked === "none"),
  };
  const hover = useCallback((chunk: string | null) => setHoveredChunk(chunk), []);

  useEffect(() => {
    if (!gesture) return;
    if (!canSelect) { setGesture(null); return; }
    const move = (event: globalThis.PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-diff-group]");
      if (!target || target.dataset.diffIdentity !== identity) return;
      const group = Number(target.dataset.diffGroup);
      setGesture(current => current ? moveDiffGesture(current, event.pointerId, group) : null);
    };
    const end = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== gesture.pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-diff-group]");
      const releaseGroup = target?.dataset.diffIdentity === identity ? Number(target?.dataset.diffGroup) : undefined;
      const result = finishDiffGesture(gesture, event.pointerId, event.type === "pointercancel", releaseGroup);
      if (result) setLines?.(result.ids, result.included);
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
  }, [canSelect, gesture, identity, setLines]);

  if (!display.hunks.size) return <p className="flex items-center gap-2 px-2 py-4 text-sm text-fg/muted">{model.rows.length
    ? <>Whitespace only{onShowWhitespace ? <button type="button" className="rounded-lg px-2 py-0.5 text-text hover:bg-accent-soft" onClick={onShowWhitespace}>Show</button> : null}</>
    : "No text changes"}</p>;

  const gutter = Boolean(selection);
  const edge = surface === "thread" ? "pl-4 md:pl-12" : "";
  const line = (item: DisplayRow, side?: Side) => <Line key={item.row.id} item={item} side={side} mode={mode} surface={surface}
    identity={identity} gutter={gutter} pickable={canSelect && item.ids.length > 0} picked={pickedOf(item.ids, selected)}
    hovered={canSelect && item.ids.length > 0 && hoveredChunk !== null && item.row.chunk === hoveredChunk} picker={picker} />;
  const chunks = (hunk: Hunk) => hunk.segments.map(segment => <ChunkControl key={segment.start} segment={segment}
    pickable={canSelect && segment.ids.length > 0} picked={pickedOf(segment.ids, selected)} onHover={hover} picker={picker} />);
  const tail = pending ? <div ref={more} aria-hidden="true" className="h-24" /> : null;
  const header = (value: string, first: boolean) => <div className={`
    whitespace-nowrap px-2 text-accent/80
    ${mode === "split" ? "flex h-8 items-center" : first ? "pb-1" : "pt-3 pb-1"}
  `}>{value}</div>;
  const shownHunks = model.hunks.flatMap((hunk, index) => {
    const rows = mounted.get(index);
    return rows ? [{ index, header: hunk.header, hunk: rows }] : [];
  });

  if (mode === "split") return <div className={`
    grid min-w-0 pb-4 font-mono text-xs leading-5
    ${gutter ? "grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[0_minmax(0,1fr)_minmax(0,1fr)]"}
    ${edge}
  `}>
    <div aria-label="Change chunks">
      {shownHunks.map(({ index, hunk }) => <Fragment key={index}>
        <div className="h-8" />
        <div className="grid auto-rows-[1.5rem]">{chunks(hunk)}</div>
      </Fragment>)}
    </div>
    {(["old", "new"] as const).map(side => <div key={side} className="scrollbar-hover-reveal min-w-0 overflow-x-auto" aria-label={side === "old" ? "Before changes" : "After changes"}>
      <div className="w-max min-w-full">
        {shownHunks.map(({ index, header: value, hunk }) => <Fragment key={index}>
          {header(value, index === 0)}
          <div className="grid auto-rows-[1.5rem] grid-cols-[auto_minmax(0,1fr)]">{hunk.rows.map(item => line(item, side))}</div>
        </Fragment>)}
      </div>
    </div>)}
    <div className="col-span-3">{tail}</div>
  </div>;

  return <div className={`
    pb-4 font-mono text-xs leading-5
    ${surface === "review" ? "scrollbar-hover-reveal overflow-x-auto" : ""}
  `}>
    {shownHunks.map(({ index, header: value, hunk }) => <div key={index} className={`min-w-max ${edge}`}>
      {header(value, index === 0)}
      <div className={`grid ${gutter ? "grid-cols-[1.5rem_auto_minmax(0,1fr)]" : "grid-cols-[0_auto_minmax(0,1fr)]"}`}>
        {chunks(hunk)}
        {hunk.rows.map(item => line(item))}
      </div>
    </div>)}
    {tail}
  </div>;
}
