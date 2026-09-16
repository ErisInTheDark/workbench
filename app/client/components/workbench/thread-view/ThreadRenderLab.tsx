/*
 * Exports:
 * - default ThreadRenderLab: edit arbitrary fixtures and rendering options without source changes.
 */
"use client";

import { useEffect, useState } from "react";

import ThreadRenderSurface from "./ThreadRenderSurface";
import { parseThreadRenderInput } from "./thread-render-lab-input";
import ThreadRenderLabBoundary from "./ThreadRenderLabBoundary";
import { parseThreadRenderContext, parseThreadRenderProjection, threadRenderFlags, withThreadRenderStatus,
  type ThreadRenderContext, type ThreadRenderFlags, type ThreadRenderTurnStatus } from "./thread-render-lab-options";
import type { ThreadPayload } from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ThreadTextPresentationController, { type ThreadTextPresentationField } from "../../../workbench/thread/ThreadTextPresentationController";
import ThreadTextPresentationContext from "../ThreadTextPresentationContext";

const buttonClass = "rounded px-3 py-1.5 text-sm hover:bg-fg-7 focus-visible:outline-2 focus-visible:outline-accent";
const inputClass = "min-w-0 rounded border border-fg-15 bg-transparent px-2 py-1 font-mono text-sm";

export default function ThreadRenderLab() {
  const [input, setInput] = useState("");
  const [contextText, setContextText] = useState("{}");
  const [inputKind, setInputKind] = useState<"thread" | "projection">("thread");
  const [fixture, setFixture] = useState<{ thread: ThreadPayload | null; projection?: WorkbenchTranscriptProjection; context: ThreadRenderContext }>({ thread: null, context: {} });
  const [flags, setFlags] = useState<ThreadRenderFlags>({ showLiveActivity: true });
  const [status, setStatus] = useState<ThreadRenderTurnStatus>("preserve");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [mount, setMount] = useState(0);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(640);
  const [fontSize, setFontSize] = useState(1);
  const [theme, setTheme] = useState("default");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [textOwner] = useState(() => new ThreadTextPresentationController());
  const [streamTurn, setStreamTurn] = useState("");
  const [streamItem, setStreamItem] = useState("");
  const [streamField, setStreamField] = useState<ThreadTextPresentationField>("commandExecutionOutput");
  const [streamIndex, setStreamIndex] = useState(0);
  const [streamText, setStreamText] = useState("");
  const [appendText, setAppendText] = useState(true);
  useEffect(() => () => textOwner.dispose(), [textOwner]);
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.workbenchTheme;
    root.dataset.workbenchTheme = theme;
    return () => {
      if (previous === undefined) delete root.dataset.workbenchTheme;
      else root.dataset.workbenchTheme = previous;
    };
  }, [theme]);
  const thread = withThreadRenderStatus(fixture.thread, status);
  const source = { kind: fixture.projection ? "sqlite" as const : "json" as const, sourceKey: "render-lab" };

  function apply() {
    try {
      const context = parseThreadRenderContext(contextText);
      if (inputKind === "projection") {
        setFixture({ thread: null, projection: parseThreadRenderProjection(input), context });
      } else {
        const parsed = parseThreadRenderInput(input);
        if (parsed.error) { setError(parsed.error); return; }
        setFixture({ thread: parsed.thread, context });
      }
      setError("");
      setRevision(value => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid rendering context.");
    }
  }

  return <main className="min-h-dvh bg-bg p-4 text-text">
    <header className="mb-4 flex flex-wrap items-center gap-3">
      <h1 className="m-0 text-lg font-semibold">Thread render lab</h1>
      <button className={buttonClass} onClick={() => setControlsVisible(value => !value)}>{controlsVisible ? "Hide controls" : "Show controls"}</button>
      <a className={buttonClass} href="/agent/thread">Open captured thread</a>
    </header>
    <div className={controlsVisible ? "grid items-start gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]" : "min-w-0"}>
      <section hidden={!controlsVisible} aria-label="Lab controls" className="min-w-0 space-y-4">
        <p className="m-0 text-sm text-fg/muted">Paste any thread, turn, item array or command shorthand. Apply updates keeps identity and interaction state. Remount starts a fresh view. Nothing executes commands.</p>
        <fieldset className="flex gap-3 text-sm"><legend>Input format</legend>
          <label><input type="radio" name="input-kind" checked={inputKind === "thread"} onChange={() => setInputKind("thread")} /> Thread / items</label>
          <label><input type="radio" name="input-kind" checked={inputKind === "projection"} onChange={() => setInputKind("projection")} /> Canonical SQL projection</label>
        </fieldset>
        <label className="block text-sm">Thread JSON
          <textarea aria-label="Thread JSON" spellCheck={false} value={input} onChange={event => setInput(event.target.value)}
            className={`${inputClass} mt-1 h-64 w-full resize-y`} />
        </label>
        <details>
          <summary className="cursor-pointer text-sm">Rendering context</summary>
          <p className="text-xs text-fg/muted">Optional renderer props: knownSkills, projectFilePaths, projectId, projectRootPath, workspaceRoots, relatedThreadsById, subagents, inlineMentionSources, hiddenDynamicToolCallItemIds, hiddenWebSearchItemIds, hiddenReasoningStep.</p>
          <textarea aria-label="Rendering context JSON" spellCheck={false} value={contextText} onChange={event => setContextText(event.target.value)}
            className={`${inputClass} h-40 w-full resize-y`} />
        </details>
        <div className="flex flex-wrap gap-1">
          <button className={buttonClass} onClick={apply}>Apply updates</button>
          <button className={buttonClass} onClick={() => { textOwner.clear(); setMount(value => value + 1); setRevision(value => value + 1); }}>Remount preview</button>
          <button className={buttonClass} onClick={() => { textOwner.clear(); setInput(""); setContextText("{}"); setFixture({ thread: null, context: {} }); setError(""); setMount(value => value + 1); setRevision(value => value + 1); }}>Clear fixture</button>
        </div>
        <p role="status" className={error ? "m-0 text-sm text-danger" : "m-0 text-xs text-fg/muted"}>{error || `Applied revision ${revision}. Invalid input leaves the last preview intact.`}</p>
        <fieldset className="space-y-1" disabled={Boolean(fixture.projection)}>
          <legend className="mb-1 text-sm font-medium">Latest turn status</legend>
          {(["preserve", "inProgress", "completed", "interrupted", "failed"] as const).map(value => <label key={value} className="mr-3 inline-flex items-center gap-1 text-sm">
            <input type="radio" name="turn-status" value={value} checked={status === value} onChange={() => setStatus(value)} />{value}
          </label>)}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Rendering</legend>
          {Object.entries(threadRenderFlags).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(flags[key as keyof ThreadRenderFlags])}
              disabled={Boolean(fixture.projection) && key !== "showLiveActivity"}
              onChange={event => setFlags(current => ({ ...current, [key]: event.target.checked }))} />{label}
          </label>)}
        </fieldset>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-sm font-medium">Viewport</legend>
          <label className="text-sm">Width px (0 = available)<input aria-label="Preview width" className={`${inputClass} block w-24`} type="number" min={0} max={3840} value={width} onChange={event => setWidth(Math.max(0, event.target.valueAsNumber || 0))} /></label>
          <label className="text-sm">Height px<input aria-label="Preview height" className={`${inputClass} block w-24`} type="number" min={120} max={2160} value={height} onChange={event => setHeight(Math.max(120, event.target.valueAsNumber || 120))} /></label>
          <label className="text-sm">Font rem<input aria-label="Preview font size" className={`${inputClass} block w-24`} type="number" min={0.5} max={3} step={0.1} value={fontSize} onChange={event => setFontSize(Math.max(0.5, event.target.valueAsNumber || 1))} /></label>
          <label className="text-sm">Palette<select aria-label="Preview palette" className={`${inputClass} block`} value={theme} onChange={event => setTheme(event.target.value)}>
            <option value="default">Default</option><option value="magical-girl">Magical girl</option><option value="winter">Winter</option>
          </select></label>
        </fieldset>
        <details>
          <summary className="cursor-pointer text-sm">Streaming text</summary>
          <p className="text-xs text-fg/muted">Apply an in-progress fixture first. Target an existing item and supply its full new text. This updates the real leaf text owner without rebuilding the transcript. Apply canonical JSON separately for completion.</p>
          <div className="grid gap-2">
            <label className="text-sm">Turn id<input aria-label="Stream turn id" className={`${inputClass} block w-full`} value={streamTurn} onChange={event => setStreamTurn(event.target.value)} /></label>
            <label className="text-sm">Item id<input aria-label="Stream item id" className={`${inputClass} block w-full`} value={streamItem} onChange={event => setStreamItem(event.target.value)} /></label>
            <label className="text-sm">Field<select aria-label="Stream field" className={`${inputClass} block w-full`} value={streamField} onChange={event => setStreamField(event.target.value as ThreadTextPresentationField)}>
              {(["agentMessageText", "commandExecutionOutput", "reasoningSummary", "reasoningContent"] as const).map(field => <option key={field}>{field}</option>)}
            </select></label>
            <label className="text-sm">Reasoning section index<input aria-label="Stream section index" type="number" min={0} className={inputClass} value={streamIndex} onChange={event => setStreamIndex(Math.max(0, event.target.valueAsNumber || 0))} /></label>
            <textarea aria-label="Stream text" className={`${inputClass} h-24 w-full`} value={streamText} onChange={event => setStreamText(event.target.value)} />
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={appendText} onChange={event => setAppendText(event.target.checked)} />Pace appended text (supply the full new text)</label>
            <button className={buttonClass} onClick={() => {
              const turn = (fixture.projection?.turns ?? thread?.turns)?.find(turn => turn.id === streamTurn);
              if (!turn?.items.some(item => item.id === streamItem)) { setError("Streaming target must identify an existing fixture item."); return; }
              const key = { source, threadId: fixture.projection?.thread.id ?? thread!.id, turnId: streamTurn, itemId: streamItem,
                field: streamField, index: streamField === "reasoningSummary" || streamField === "reasoningContent" ? streamIndex : null };
              if (!textOwner.hasSubscribers(key)) { setError("This text field is not mounted. Check the field and section, use an in-progress turn, and open its disclosure."); return; }
              const current = textOwner.getSnapshot(key) ?? "";
              if (appendText && streamText.startsWith(current) && streamText.length > current.length) {
                textOwner.acceptDelta({ key, canonicalText: streamText, delta: streamText.slice(current.length) });
              }
              else textOwner.complete(key, streamText, { snap: true });
              setError("");
            }}>Publish text</button>
          </div>
        </details>
        <p className="text-xs text-fg/muted">Preview uses your browser colour scheme. Browser viewport/device emulation tests real mobile media queries; width only sizes this pane. SQL projections retain their canonical grouping; edit their turn status in JSON. Daemon-backed actions require the normal app.</p>
      </section>
      <section aria-label="Thread preview" className="min-w-0 overflow-x-auto">
        <div className="border border-fg-15" style={{ width: width || "100%", height }} data-thread-render-lab-preview>
          <ThreadRenderLabBoundary revision={revision}>
            <ThreadTextPresentationContext value={textOwner}>
              <ThreadRenderSurface key={mount} thread={thread} context={fixture.context} flags={flags} fontSizeRem={fontSize} emptyMessage="No fixture applied."
                presentationSource={source} sql={fixture.projection ? { projection: fixture.projection, loading: false, canLoadPrevious: false, loadPrevious: () => {} } : undefined} />
            </ThreadTextPresentationContext>
          </ThreadRenderLabBoundary>
        </div>
      </section>
    </div>
  </main>;
}
