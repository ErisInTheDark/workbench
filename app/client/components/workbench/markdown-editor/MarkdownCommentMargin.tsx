/*
 * Exports:
 * - default MarkdownCommentMargin: comment threads beside the markdown editor: cards aligned to what they discuss and
 *   pushed apart so they never overlap, or inline badges that open a card where the pane is too narrow. Threads take
 *   replies, edits and resolution; a draft card writes a new thread.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { MarkdownComment } from "../../../workbench/markdown/comment-markdown";
import type {
  CommentDraftView,
  CommentMarginSnapshot,
  CommentThreadView,
} from "../../../workbench/editor/WorkbenchCommentController";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import { CheckIcon, MessageSquarePlusIcon, SquarePenIcon, Trash2Icon } from "../workbench-icons";
import type { CommentMarginLayout } from "./use-editor-margin-layout";

const CARD_GAP_PX = 10;
const DRAFT_ID = "draft";
const EMPTY_SNAPSHOT: CommentMarginSnapshot = { activeId: null, draft: null, threads: [] };
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

type Comments = WorkbenchFilePanelClient["comments"];

interface PlacedItem {
  id: string;
  top: number;
}

/**
 * Cards stack downwards from their anchors without overlapping. The focused card then sits exactly at its anchor:
 * cards after it are pushed down and cards before it pushed up only as far as needed.
 */
function placeCards(items: readonly PlacedItem[], heights: Readonly<Record<string, number>>, focusId: string | null) {
  const sorted = [...items].sort((left, right) => left.top - right.top);
  const tops = new Map(sorted.map((item) => [item.id, item.top]));
  const height = (id: string) => heights[id] ?? 72;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    tops.set(sorted[index]!.id, Math.max(sorted[index]!.top, tops.get(previous.id)! + height(previous.id) + CARD_GAP_PX));
  }

  const focusIndex = sorted.findIndex((item) => item.id === focusId);
  if (focusIndex < 0) {
    return tops;
  }

  tops.set(focusId!, sorted[focusIndex]!.top);
  for (let index = focusIndex + 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const minimum = tops.get(previous.id)! + height(previous.id) + CARD_GAP_PX;
    tops.set(sorted[index]!.id, Math.max(sorted[index]!.top, minimum));
  }
  for (let index = focusIndex - 1; index >= 0; index -= 1) {
    const next = sorted[index + 1]!;
    const maximum = tops.get(next.id)! - height(sorted[index]!.id) - CARD_GAP_PX;
    tops.set(sorted[index]!.id, Math.max(0, Math.min(tops.get(sorted[index]!.id)!, maximum)));
  }
  return tops;
}

function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void, cancel: () => void) {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  }
}

function CommentBox({
  autoFocus = false,
  initial = "",
  onCancel,
  onSubmit,
  placeholder,
  submitLabel,
}: {
  autoFocus?: boolean;
  initial?: string;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  placeholder: string;
  submitLabel: string;
}) {
  const [value, setValue] = useState(initial);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  const submit = () => {
    if (!value.trim()) return;
    onSubmit(value);
    setValue("");
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <textarea
        ref={textarea}
        rows={1}
        value={value}
        placeholder={placeholder}
        className="
          w-full resize-none rounded-[0.6rem] bg-fg/5 px-2.5 py-1.5 text-[0.86rem] leading-snug text-text outline-none
          placeholder:text-fg/45 focus:bg-fg/8
        "
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => submitOnEnter(event, submit, onCancel)}
      />
      {value.trim() || initial ? (
        <div className="flex justify-end gap-1">
          <button type="button" className="rounded-full px-2.5 py-1 text-[0.78rem] text-fg/muted hover:bg-fg/5 hover:text-text" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!value.trim()}
            className="rounded-full bg-accent-soft px-2.5 py-1 text-[0.78rem] font-medium text-accent hover:brightness-110 disabled:opacity-45"
            onClick={submit}
          >
            {submitLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CommentEntry({
  comment,
  onDelete,
  onEdit,
}: {
  comment: MarkdownComment;
  onDelete: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentBox
        autoFocus
        initial={comment.body}
        placeholder="Edit comment"
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={(body) => {
          onEdit(body);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="group/comment relative py-1">
      {comment.author ? <p className="m-0 text-[0.76rem] font-semibold text-text">{comment.author}</p> : null}
      <p className="m-0 whitespace-pre-wrap break-words pr-12 text-[0.86rem] leading-snug text-text">{comment.body}</p>
      <span className="absolute top-0.5 right-0 flex opacity-0 transition-opacity group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 coarse-touch:opacity-100">
        <IconButton label="Edit comment" size="compact" display="hover-border" onClick={() => setEditing(true)}>
          <SquarePenIcon size={14} />
        </IconButton>
        <IconButton label="Delete comment" size="compact" display="hover-border" tone="danger" onClick={onDelete}>
          <Trash2Icon size={14} />
        </IconButton>
      </span>
    </div>
  );
}

function ThreadCard({ active, comments, thread }: { active: boolean; comments: Comments; thread: CommentThreadView }) {
  return (
    <>
      <div className="flex items-start gap-2">
        {thread.quote ? (
          <p className="m-0 min-w-0 flex-1 truncate border-l-2 border-[color-mix(in_srgb,var(--attention)_60%,transparent)] pl-2 text-[0.76rem] text-fg/muted">
            {thread.quote}
          </p>
        ) : <span className="flex-1" />}
        <IconButton
          label="Resolve thread"
          size="compact"
          display="hover-border"
          className="-mt-0.5 -mr-1"
          onClick={(event) => {
            event.stopPropagation();
            comments.resolve(thread.id);
          }}
        >
          <CheckIcon size={14} />
        </IconButton>
      </div>
      <div className="mt-1 flex flex-col [&>*+*]:(border-t border-fg-alpha/8)">
        {thread.comments.map((comment, index) => (
          <CommentEntry
            key={`${index}:${comment.body}`}
            comment={comment}
            onDelete={() => comments.deleteComment(thread.id, index)}
            onEdit={(body) => comments.editComment(thread.id, index, body)}
          />
        ))}
      </div>
      {active ? (
        <CommentBox
          placeholder="Reply"
          submitLabel="Reply"
          onCancel={() => comments.setActive(null)}
          onSubmit={(body) => comments.reply(thread.id, body)}
        />
      ) : null}
    </>
  );
}

function DraftCard({ comments, draft }: { comments: Comments; draft: CommentDraftView }) {
  return (
    <>
      {draft.quote ? (
        <p className="m-0 truncate border-l-2 border-[color-mix(in_srgb,var(--attention)_60%,transparent)] pl-2 text-[0.76rem] text-fg/muted">
          {draft.quote}
        </p>
      ) : null}
      <CommentBox
        autoFocus
        placeholder="Add a comment"
        submitLabel="Comment"
        onCancel={() => comments.cancelDraft()}
        onSubmit={(body) => comments.submitDraft(body)}
      />
    </>
  );
}

const cardClassName = `
  absolute right-0 left-0 rounded-[0.9rem] border px-3 py-2 transition-[top,border-color,background-color] duration-150 ease-out
  motion-reduce:transition-none
  bg-[color-mix(in_srgb,var(--app-bg-solid)_96%,var(--text)_4%)]
`;

export default function MarkdownCommentMargin({
  client,
  layout,
}: {
  client: WorkbenchFilePanelClient | null;
  layout: CommentMarginLayout;
}) {
  const comments = client?.comments ?? null;
  const snapshot = useSyncExternalStore(comments?.subscribe ?? noSubscription, comments?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const cards = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const resizeObserver = useRef<ResizeObserver | null>(null);

  // Cards grow as replies are typed without this component re-rendering, so their size is observed, not read per render.
  useLayoutEffect(() => {
    const measure = () => {
      const measured: Record<string, number> = {};
      for (const [id, element] of cards.current) measured[id] = element.offsetHeight;
      setHeights((current) => JSON.stringify(current) === JSON.stringify(measured) ? current : measured);
    };
    resizeObserver.current = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of cards.current.values()) resizeObserver.current?.observe(element);
    measure();
    return () => {
      resizeObserver.current?.disconnect();
      resizeObserver.current = null;
    };
  }, [snapshot, layout.mode]);

  if (!comments || (!snapshot.threads.length && !snapshot.draft)) {
    return null;
  }

  const cardRef = (id: string) => (element: HTMLElement | null) => {
    if (element) {
      cards.current.set(id, element);
      resizeObserver.current?.observe(element);
    } else {
      cards.current.delete(id);
    }
  };

  if (layout.mode === "inline") {
    const open = snapshot.draft
      ? { id: DRAFT_ID, top: snapshot.draft.top }
      : snapshot.threads.find((thread) => thread.id === snapshot.activeId) ?? null;
    const badgeTops = placeCards(snapshot.threads, Object.fromEntries(snapshot.threads.map(({ id }) => [id, 24])), null);
    return (
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20" aria-label="Comments">
        {snapshot.threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            aria-label={`Comment thread with ${thread.comments.length} ${thread.comments.length === 1 ? "note" : "notes"}`}
            className={`
              pointer-events-auto absolute -right-1 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1
              text-[0.7rem] font-semibold transition-colors
              ${thread.id === snapshot.activeId ? "bg-[color-mix(in_srgb,var(--attention)_40%,transparent)] text-text" : "bg-[color-mix(in_srgb,var(--attention)_22%,transparent)] text-fg/80"}
            `}
            style={{ top: badgeTops.get(thread.id) ?? thread.top }}
            onClick={() => comments.setActive(thread.id === snapshot.activeId ? null : thread.id)}
          >
            <MessageSquarePlusIcon size={12} />
            {thread.comments.length > 1 ? thread.comments.length : null}
          </button>
        ))}
        {open ? (
          <section
            ref={cardRef(open.id)}
            className={`${cardClassName} pointer-events-auto z-10 border-[color-mix(in_srgb,var(--attention)_45%,transparent)]`}
            style={{ top: open.top + 28 }}
          >
            {snapshot.draft ? <DraftCard comments={comments} draft={snapshot.draft} /> : (
              <ThreadCard active comments={comments} thread={snapshot.threads.find((thread) => thread.id === open.id)!} />
            )}
          </section>
        ) : null}
      </div>
    );
  }

  const items: PlacedItem[] = [
    ...snapshot.threads.map(({ id, top }) => ({ id, top })),
    ...(snapshot.draft ? [{ id: DRAFT_ID, top: snapshot.draft.top }] : []),
  ];
  const tops = placeCards(items, heights, snapshot.draft ? DRAFT_ID : snapshot.activeId);

  return (
    <aside
      aria-label="Comments"
      className="absolute top-0"
      style={{ left: layout.left, width: layout.width }}
    >
      {snapshot.threads.map((thread) => {
        const active = thread.id === snapshot.activeId;
        return (
          <section
            key={thread.id}
            ref={cardRef(thread.id)}
            className={`
              ${cardClassName}
              ${active ? "z-10 border-[color-mix(in_srgb,var(--attention)_45%,transparent)]" : "cursor-pointer border-fg-alpha/8 hover:border-fg-alpha/16"}
            `}
            style={{ top: tops.get(thread.id) ?? thread.top }}
            onClick={() => {
              if (!active) comments.setActive(thread.id);
            }}
          >
            <ThreadCard active={active} comments={comments} thread={thread} />
          </section>
        );
      })}
      {snapshot.draft ? (
        <section
          ref={cardRef(DRAFT_ID)}
          className={`${cardClassName} z-10 border-[color-mix(in_srgb,var(--attention)_45%,transparent)]`}
          style={{ top: tops.get(DRAFT_ID) ?? snapshot.draft.top }}
        >
          <DraftCard comments={comments} draft={snapshot.draft} />
        </section>
      ) : null}
    </aside>
  );
}
