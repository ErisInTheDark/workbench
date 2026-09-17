/* Exports: default WorkbenchGitComposer: render the sticky commit/amend/stash intent surface. */
"use client";
import { useState } from "react";
import StickyComposerSurface from "../thread-view/StickyComposerSurface";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitComposer({ getViewport }: { getViewport(): HTMLDivElement | null }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [collapsed, setCollapsed] = useState(false);
  const repository = state.repository;
  const draft = snapshot.draft;
  const staleHead = draft.mode === "amend" && draft.targetCommit !== repository?.head;
  const reason = (staleHead ? "HEAD changed. Review its message before amending." : null)
    || repository?.blockedReason || (draft.mode === "amend" ? repository?.amendReason : null)
    || (draft.mode === "stash" && !repository?.head ? "Create the initial commit before stashing." : null);
  const disabled = snapshot.busy || snapshot.status !== "ready" || !repository || Boolean(reason)
    || (draft.mode !== "amend" && !snapshot.selections.length) || (draft.mode !== "stash" && !draft.title.trim());
  const label = draft.mode === "amend" ? "Amend commit" : draft.mode === "stash" ? "Stash changes" : "Commit changes";
  return <StickyComposerSurface getViewport={getViewport} collapsed={collapsed} onCollapsedChange={setCollapsed}
    collapsedLabel="Expand Git composer" collapseLabel="Collapse Git composer"
    collapsedContent={draft.title || `${label} · ${snapshot.selections.length} files`}
    collapsedAccessory={<span className="text-xs text-fg/muted">{snapshot.busy ? "Working..." : draft.mode}</span>}>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!disabled) void state.submit(); }}
      onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !disabled) {
          event.preventDefault();
          void state.submit();
        }
      }}>
      <div className="flex items-center gap-2 pr-8">
        <input aria-label={draft.mode === "stash" ? "Stash message" : "Commit title"} placeholder={draft.mode === "stash" ? "Stash message (optional)" : "Commit title"}
          className="min-w-0 flex-1 bg-transparent px-1 py-2 font-medium outline-none" disabled={snapshot.busy}
          value={draft.title} onChange={event => state.setDraft({ title: event.target.value })} />
        <span className="text-xs tabular-nums text-fg/muted" title="Title character count">{draft.title.length}</span>
      </div>
      <textarea aria-label="Commit description" placeholder="Description (optional)" rows={2}
        className="max-h-64 w-full resize-y bg-transparent px-1 text-sm outline-none"
        disabled={snapshot.busy} value={draft.description} onChange={event => state.setDraft({ description: event.target.value })} />
      {reason ? <p className="m-0 text-xs text-fg/muted">{reason}</p> : null}
      {staleHead ? <button type="button" disabled={snapshot.busy} className="rounded-lg px-2 py-1 text-sm text-accent hover:bg-accent-soft"
        onClick={() => state.reviewHead()}>Load current HEAD message</button> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-auto text-fg/muted">{snapshot.selections.length} files selected{snapshot.selections.some(selection => selection.lineIds !== null) ? " · partial changes" : ""}</span>
        <div className="flex gap-1" aria-label="Git action mode">
          {(["commit", "amend", "stash"] as const).map(mode => <button key={mode} type="button" aria-pressed={draft.mode === mode}
            disabled={snapshot.busy} className={`
              rounded-lg px-2 py-1.5 hover:bg-accent-soft
              ${draft.mode === mode ? "font-semibold text-accent" : "text-fg/muted"}
            `} onClick={() => state.setMode(mode)}>{mode === "commit" ? "Commit" : mode === "amend" ? "Amend" : "Stash"}</button>)}
        </div>
        <button type="submit" disabled={disabled} className="rounded-lg px-3 py-2 font-semibold text-accent hover:bg-accent-soft disabled:opacity-40">
          {snapshot.busy ? "Working..." : label}
        </button>
      </div>
    </form>
  </StickyComposerSurface>;
}
