/* Exports: default WorkbenchGitComposer: render the sticky commit/amend/stash intent surface. */
"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { WORKING_TREE_STASH_MESSAGE } from "workbench-shared/workbench/git/working-tree-message";
import { editWorkingTreeMessage, WORKING_TREE_SUBJECT_LIMIT } from "../../../workbench/git/working-tree-message";
import PrimaryButton from "../PrimaryButton";
import PlaintextEditable, { type PlaintextEditableHandle } from "../thread-view/PlaintextEditable";
import StickyComposerSurface from "../thread-view/StickyComposerSurface";
import WorkbenchModeRow from "../WorkbenchModeRow";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitComposer ({ getViewport }: { getViewport (): HTMLDivElement | null }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [collapsed, setCollapsed] = useState(false);
  const [focusOffset, setFocusOffset] = useState<number | null>(null);
  const body = useRef<PlaintextEditableHandle>(null);
  const composing = useRef(false);
  const repository = state.repository;
  const draft = snapshot.draft;
  const staleHead = draft.mode === "amend" && draft.targetCommit !== repository?.head;
  const reason = (staleHead ? "HEAD changed. Review its message before amending." : null)
    || repository?.blockedReason || (draft.mode === "amend" ? repository?.amendReason : null)
    || (draft.mode === "stash" && !repository?.head ? "Create the initial commit before stashing." : null);
  const disabled = state.mutationBlocked || !repository || Boolean(reason)
    || (draft.mode !== "amend" && !snapshot.selections.length) || (draft.mode !== "stash" && !draft.title.trim());
  const label = draft.mode === "amend" ? "Amend commit" : draft.mode === "stash" ? "Stash changes" : "Commit changes";
  const remaining = WORKING_TREE_SUBJECT_LIMIT - Array.from(draft.title).length;
  const placeholder = draft.mode === "stash" ? WORKING_TREE_STASH_MESSAGE : "Commit title";
  useLayoutEffect(() => {
    if (focusOffset === null) return;
    body.current?.focus(focusOffset);
    setFocusOffset(null);
  }, [focusOffset, draft.description]);
  const changeTitle = (title: string) => {
    if (composing.current || draft.mode === "stash") { state.setDraft({ title }); return; }
    const next = editWorkingTreeMessage(title, draft.description);
    state.setDraft({ title: next.title, description: next.description });
    if (next.focusOffset !== null) setFocusOffset(next.focusOffset);
  };
  return <StickyComposerSurface getViewport={getViewport} collapsed={collapsed} onCollapsedChange={setCollapsed}
    collapsedLabel="Expand Git composer" collapseLabel="Collapse Git composer"
    collapsedContent={draft.title || `${label} · ${snapshot.selections.length} files`}
    collapsedAccessory={<span className="text-xs text-fg/muted">{snapshot.busy ? "Working..." : draft.mode}</span>}>
    <form className="space-y-1" onSubmit={event => { event.preventDefault(); if (!disabled) void state.submit(); }}
      onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !disabled) {
          event.preventDefault();
          void state.submit();
        }
      }}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pr-8">
        <div className={`
          relative inline-grid max-w-full grid-cols-[minmax(0,1fr)] font-medium
          ${draft.title ? "min-w-0" : "min-w-[min(20rem,100%)]"}
        `}>
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre px-1 py-1">{draft.title || placeholder}</span>
          <input aria-label={draft.mode === "stash" ? "Stash message" : "Commit title"} placeholder={placeholder}
            className="absolute inset-0 min-w-0 w-full bg-transparent px-1 py-1 outline-none placeholder:text-fg/muted" disabled={snapshot.busy}
            value={draft.title} onChange={event => changeTitle(event.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={event => { composing.current = false; changeTitle(event.currentTarget.value); }}
            onPaste={event => {
              const text = event.clipboardData.getData("text/plain");
              if (draft.mode === "stash" || !/[\r\n]/u.test(text)) return;
              event.preventDefault();
              const input = event.currentTarget;
              changeTitle(input.value.slice(0, input.selectionStart ?? input.value.length) + text + input.value.slice(input.selectionEnd ?? input.value.length));
            }}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && draft.mode !== "stash") {
                event.preventDefault();
                body.current?.focus(0);
              }
            }} />
        </div>
        {draft.title && draft.mode !== "stash" ? <span className="inline-flex shrink-0 items-center gap-2 text-xs tabular-nums text-fg/muted" aria-label={`${remaining} characters remaining`}>
          <WorkbenchProgressWheel percent={remaining / WORKING_TREE_SUBJECT_LIMIT * 100} />
          <span>{remaining}</span>
        </span> : null}
      </div>
      {draft.mode !== "stash" ? <PlaintextEditable ref={body} ariaLabel="Commit description" placeholder="Description (optional)"
        className="scrollbar-hover-reveal max-h-64 min-h-10 w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-1 text-sm text-fg/muted outline-none data-[empty=true]:before:text-fg/32 data-[empty=true]:before:content-[attr(data-placeholder)] focus:text-text"
        disabled={snapshot.busy} value={draft.description} onChange={description => state.setDraft({ description })} /> : null}
      {reason ? <p className="m-0 text-xs text-fg/muted">{reason}</p> : null}
      {staleHead ? <button type="button" disabled={snapshot.busy} className="rounded-lg px-2 py-1 text-sm text-accent hover:bg-accent-soft"
        onClick={() => state.reviewHead()}>Load current HEAD message</button> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-auto text-fg/muted">{snapshot.selections.length} files selected{snapshot.selections.some(selection => selection.lineIds !== null) ? " · partial changes" : ""}</span>
        <WorkbenchModeRow ariaLabel="Git action mode" value={draft.mode} disabled={snapshot.busy}
          onChange={mode => state.setMode(mode)} options={[
            { value: "commit", label: "Commit", ariaLabel: "Commit", icon: null },
            { value: "amend", label: "Amend", ariaLabel: "Amend", icon: null },
            { value: "stash", label: "Stash", ariaLabel: "Stash", icon: null },
          ]} />
        <PrimaryButton type="submit" disabled={disabled} pendingHalo={snapshot.busy}>
          {snapshot.busy ? "Working..." : label}
        </PrimaryButton>
      </div>
    </form>
  </StickyComposerSurface>;
}
