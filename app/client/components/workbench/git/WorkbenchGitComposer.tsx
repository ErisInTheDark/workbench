/* Exports: default WorkbenchGitComposer: the sticky commit, amend, stash and new-branch surface, tinted by its mode. */
"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WORKING_TREE_STASH_MESSAGE } from "workbench-shared/workbench/git/working-tree-message";
import { GitBranchNameSchema } from "workbench-shared/workbench/git/git-peer-contracts";
import type { WorkingTreeDraft } from "../../../workbench/git/WorkbenchWorkingTreeState";
import { editWorkingTreeMessage, WORKING_TREE_SUBJECT_LIMIT } from "../../../workbench/git/working-tree-message";
import PrimaryButton from "../../ui/PrimaryButton";
import RadioRow from "../../ui/RadioRow";
import PlaintextEditable, { type PlaintextEditableHandle } from "../thread-view/PlaintextEditable";
import StickyComposerSurface from "../thread-view/StickyComposerSurface";
import { GitBranchIcon, GitCommitIcon, GitStashIcon, Undo2Icon, type IconProps } from "../workbench-icons";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";
import { WorkbenchGitFileTotals } from "./WorkbenchGitFileRow";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

type Mode = WorkingTreeDraft["mode"];
const MODES: Record<Mode, { label: string; action: string; Icon: (props: IconProps) => ReactNode; tint: string }> = {
  commit: { label: "Commit", action: "Commit", Icon: GitCommitIcon, tint: "" },
  amend: { label: "Amend", action: "Amend", Icon: Undo2Icon, tint: "bg-[color-mix(in_srgb,var(--color-indigo-500)_7%,transparent)]" },
  stash: { label: "Stash", action: "Stash", Icon: GitStashIcon, tint: "bg-[color-mix(in_srgb,var(--color-teal-500)_7%,transparent)]" },
  branch: { label: "Branch", action: "Branch", Icon: GitBranchIcon, tint: "bg-[color-mix(in_srgb,var(--color-sky-500)_7%,transparent)]" },
};

/** A branch name suggested from the commit title, so typing the title is usually enough. */
function suggestBranch(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
}

export default function WorkbenchGitComposer({ getViewport }: { getViewport(): HTMLDivElement | null }) {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const [collapsed, setCollapsed] = useState(false);
  const [focusOffset, setFocusOffset] = useState<number | null>(null);
  const body = useRef<PlaintextEditableHandle>(null);
  const composing = useRef(false);
  const repository = state.repository;
  const draft = snapshot.draft;
  const mode = MODES[draft.mode];
  const branch = draft.branch.trim() || suggestBranch(draft.title);
  const branchValid = GitBranchNameSchema.safeParse(branch).success;
  const staleHead = draft.mode === "amend" && draft.targetCommit !== repository?.head;
  const reason = repository?.blockedReason
    || (draft.mode === "amend" && !staleHead ? repository?.amendReason : null)
    || (draft.mode === "stash" && !repository?.head ? "Stashing needs a first commit." : null);
  const disabled = state.mutationBlocked || !repository || Boolean(reason) || staleHead
    || (draft.mode !== "amend" && !snapshot.selections.length) || (draft.mode !== "stash" && !draft.title.trim())
    || (draft.mode === "branch" && !branchValid);
  const remaining = WORKING_TREE_SUBJECT_LIMIT - Array.from(draft.title).length;
  const placeholder = draft.mode === "stash" ? WORKING_TREE_STASH_MESSAGE : "Commit title";
  const selectedFiles = repository?.files.filter(file => snapshot.selections.some(selection => selection.path === file.path)) ?? [];
  const partial = snapshot.selections.some(selection => selection.lineIds !== null);
  useLayoutEffect(() => {
    if (focusOffset === null) return;
    body.current?.focus(focusOffset);
    setFocusOffset(null);
  }, [focusOffset, draft.description]);
  const submit = () => {
    if (disabled) return;
    if (draft.mode === "branch" && !draft.branch.trim()) state.setDraft({ branch });
    void state.submit();
  };
  const changeTitle = (title: string) => {
    if (composing.current || draft.mode === "stash") { state.setDraft({ title }); return; }
    const next = editWorkingTreeMessage(title, draft.description);
    state.setDraft({ title: next.title, description: next.description });
    if (next.focusOffset !== null) setFocusOffset(next.focusOffset);
  };
  return <StickyComposerSurface getViewport={getViewport} collapsed={collapsed} onCollapsedChange={setCollapsed}
    collapsedLabel="Expand composer" collapseLabel="Collapse composer"
    collapsedContent={draft.title || <span className="text-fg/muted">{mode.label}</span>}
    collapsedPreviewKind={draft.title ? undefined : "placeholder"}
    collapsedAccessory={<span className="inline-flex items-center gap-1 text-xs tabular-nums text-fg/muted"><mode.Icon size={14} />{snapshot.selections.length}</span>}>
    <form className={`-m-1 space-y-1 rounded-[0.9rem] p-1 transition-colors duration-surface ${mode.tint}`}
      onSubmit={event => { event.preventDefault(); submit(); }}
      onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
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
      {draft.mode !== "stash" ? <PlaintextEditable ref={body} ariaLabel="Commit description" placeholder="Description"
        className="scrollbar-hover-reveal max-h-64 min-h-10 w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-1 text-sm text-fg/muted outline-none data-[empty=true]:before:text-fg/32 data-[empty=true]:before:content-[attr(data-placeholder)] focus:text-text"
        disabled={snapshot.busy} value={draft.description} onChange={description => state.setDraft({ description })} /> : null}
      {draft.mode === "branch" ? <label className="flex items-center gap-2 px-1 text-sm">
        <GitBranchIcon size={14} className="shrink-0 text-fg/muted" />
        <input aria-label="New branch name" placeholder={branch || "branch-name"} value={draft.branch} disabled={snapshot.busy}
          onChange={event => state.setDraft({ branch: event.target.value.replace(/\s+/gu, "-") })}
          className={`
            min-w-0 flex-1 bg-transparent py-0.5 font-mono text-[0.82rem] outline-none placeholder:text-fg/40
            ${branch && !branchValid ? "text-danger" : ""}
          `} />
      </label> : null}
      {staleHead ? <p className="m-0 flex items-center gap-2 px-1 text-xs text-fg/muted">
        <span>HEAD moved</span>
        <button type="button" disabled={snapshot.busy} className="rounded-lg px-2 py-0.5 text-text hover:bg-accent-soft" onClick={() => state.reviewHead()}>
          Amend the new HEAD
        </button>
      </p> : reason ? <p className="m-0 px-1 text-xs text-fg/muted">{reason}</p> : null}
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        <span className="mr-auto inline-flex items-center gap-2 px-1 tabular-nums text-fg/muted">
          {snapshot.selections.length && !partial ? <WorkbenchGitFileTotals files={selectedFiles} /> : null}
        </span>
        <RadioRow ariaLabel="Mode" value={draft.mode} disabled={snapshot.busy}
          onChange={next => state.setMode(next)} options={(Object.keys(MODES) as Mode[]).map(value => ({
            value, label: MODES[value].label, icon: null,
            disabled: value === "amend" && Boolean(repository && !repository.head),
          }))} />
        <PrimaryButton type="submit" disabled={disabled} pendingHalo={snapshot.busy}>
          <mode.Icon size={16} className="mr-1.5" />{mode.action}
        </PrimaryButton>
      </div>
    </form>
  </StickyComposerSurface>;
}
