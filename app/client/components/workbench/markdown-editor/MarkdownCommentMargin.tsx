/*
 * Exports:
 * - default MarkdownCommentMargin: comment threads beside the markdown editor: cards aligned to what they discuss,
 *   pushed apart so they never overlap and flowing around suggestion rows, or inline badges that open a card where the pane is too narrow. Threads take
 *   replies, edits and resolution; a draft card writes a new thread.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { MarkdownComment } from "../../../workbench/markdown/comment-markdown";
import type {
  CommentDraftView,
  CommentMarginSnapshot,
  CommentThreadView,
} from "../../../workbench/editor/WorkbenchCommentController";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import { CheckIcon, MessageSquareTextIcon, SquarePenIcon, Trash2Icon } from "../workbench-icons";
import type { CommentMarginLayout } from "./use-editor-margin-layout";

const CARD_GAP_PX = 10;
const DRAFT_ID = "draft";
const EMPTY_SNAPSHOT: CommentMarginSnapshot = { activeId: null, draft: null, hoveredId: null, obstacles: [], threads: [] };
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

type Comments = WorkbenchFilePanelClient["comments"];

interface PlacedItem {
  id: string;
  top: number;
}

type Obstacles = CommentMarginSnapshot["obstacles"];

/** A stretch of margin between obstacles; cards whose anchors fall in it stay in it while they fit. */
interface MarginSection {
  bottom: number;
  items: PlacedItem[];
  top: number;
}

/** Split the margin at obstacles. An anchor inside an obstacle belongs to the stretch after it. */
function sectionsBetween(items: readonly PlacedItem[], obstacles: Obstacles): MarginSection[] {
  const sorted = [...obstacles].sort((left, right) => left.top - right.top);
  const sections: MarginSection[] = [];
  let top = -Infinity;
  for (const obstacle of sorted) {
    sections.push({ bottom: obstacle.top - CARD_GAP_PX, items: [], top });
    top = obstacle.bottom + CARD_GAP_PX;
  }
  sections.push({ bottom: Infinity, items: [], top });
  for (const item of [...items].sort((left, right) => left.top - right.top)) {
    const index = sorted.findIndex((obstacle) => item.top < obstacle.bottom);
    sections[index < 0 ? sections.length - 1 : index]!.items.push(item);
  }
  return sections;
}

/**
 * Cards stack downwards from their anchors without overlapping. The focused card then sits at its anchor: cards
 * after it are pushed down and cards before it pushed up only as far as needed. Obstacles split the margin into
 * sections: cards stay in their anchor's section, sliding up within it when they would run into the obstacle below,
 * and only spill past an obstacle when the section is too short to hold them.
 */
function placeCards(
  items: readonly PlacedItem[],
  heights: Readonly<Record<string, number>>,
  focusId: string | null,
  obstacles: Obstacles = [],
) {
  const height = (id: string) => heights[id] ?? 72;
  const tops = new Map<string, number>();
  let floor = -Infinity;

  for (const section of sectionsBetween(items, obstacles)) {
    const { items: sorted } = section;
    const sectionTop = Math.max(section.top, floor);
    const placed = sorted.map((item) => Math.max(item.top, sectionTop));
    for (let index = 1; index < sorted.length; index += 1) {
      placed[index] = Math.max(placed[index]!, placed[index - 1]! + height(sorted[index - 1]!.id) + CARD_GAP_PX);
    }

    const focusIndex = sorted.findIndex((item) => item.id === focusId);
    if (focusIndex >= 0) {
      placed[focusIndex] = Math.max(sorted[focusIndex]!.top, sectionTop);
      for (let index = focusIndex + 1; index < sorted.length; index += 1) {
        placed[index] = Math.max(sorted[index]!.top, placed[index - 1]! + height(sorted[index - 1]!.id) + CARD_GAP_PX);
      }
      for (let index = focusIndex - 1; index >= 0; index -= 1) {
        placed[index] = Math.min(placed[index]!, placed[index + 1]! - height(sorted[index]!.id) - CARD_GAP_PX);
      }
    }

    // Slide up out of the obstacle below, but never above the section's top.
    let limit = section.bottom;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      placed[index] = Math.max(sectionTop, Math.min(placed[index]!, limit - height(sorted[index]!.id)));
      limit = placed[index]! - CARD_GAP_PX;
    }
    for (let index = 1; index < sorted.length; index += 1) {
      placed[index] = Math.max(placed[index]!, placed[index - 1]! + height(sorted[index - 1]!.id) + CARD_GAP_PX);
    }

    sorted.forEach((item, index) => tops.set(item.id, placed[index]!));
    const last = sorted.at(-1);
    if (last) floor = tops.get(last.id)! + height(last.id) + CARD_GAP_PX;
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

/** A darker strip across the card's top holding the words a comment highlights. */
function CardHeader({ children, quote }: { children?: ReactNode; quote: string }) {
  return (
    <div className="-mx-3 -mt-2 mb-1 flex items-center gap-2 rounded-t-[0.9rem] bg-fg/5 px-3 py-1.5">
      <p className="m-0 min-w-0 flex-1 truncate text-[0.76rem] text-fg/muted">{quote}</p>
      {children}
    </div>
  );
}

function ThreadCard({ active, comments, thread }: { active: boolean; comments: Comments; thread: CommentThreadView }) {
  const resolveButton = (
    <IconButton
      label="Resolve thread"
      size="compact"
      display="bordered"
      className="shrink-0"
      onClick={(event) => {
        event.stopPropagation();
        comments.resolve(thread.id);
      }}
    >
      <CheckIcon size={14} />
    </IconButton>
  );
  const entries = (
    <div className="flex min-w-0 flex-1 flex-col [&>*+*]:(border-t border-fg-alpha/8)">
      {thread.comments.map((comment, index) => (
        <CommentEntry
          key={`${index}:${comment.body}`}
          comment={comment}
          onDelete={() => comments.deleteComment(thread.id, index)}
          onEdit={(body) => comments.editComment(thread.id, index, body)}
        />
      ))}
    </div>
  );

  // Only comments on selected words carry a header; one left at a position starts straight with its notes.
  return (
    <>
      {thread.anchored && thread.quote ? (
        <>
          <CardHeader quote={thread.quote}>{resolveButton}</CardHeader>
          {entries}
        </>
      ) : (
        <div className="flex items-start gap-2">
          {entries}
          <span className="mt-0.5">{resolveButton}</span>
        </div>
      )}
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
      {draft.quote ? <CardHeader quote={draft.quote} /> : null}
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
  absolute right-0 left-0 rounded-[0.9rem] px-3 py-2 transition-[top,background-color] duration-150 ease-out
  motion-reduce:transition-none
`;
const restingCardClassName = "bg-[color-mix(in_srgb,var(--app-bg-solid)_95%,var(--text)_5%)]";
const litCardClassName = "bg-[color-mix(in_srgb,var(--app-bg-solid)_89%,var(--text)_11%)]";

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
            <MessageSquareTextIcon size={12} />
            {thread.comments.length > 1 ? thread.comments.length : null}
          </button>
        ))}
        {open ? (
          <section
            ref={cardRef(open.id)}
            className={`${cardClassName} ${litCardClassName} pointer-events-auto z-10`}
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
  const tops = placeCards(items, heights, snapshot.draft ? DRAFT_ID : snapshot.activeId, snapshot.obstacles);

  return (
    <aside
      aria-label="Comments"
      className="absolute top-0"
      style={{ left: layout.left, width: layout.width }}
    >
      {snapshot.threads.map((thread) => {
        const active = thread.id === snapshot.activeId;
        const lit = active || thread.id === snapshot.hoveredId;
        return (
          <section
            key={thread.id}
            ref={cardRef(thread.id)}
            className={`
              ${cardClassName}
              ${lit ? litCardClassName : restingCardClassName}
              ${active ? "z-10" : "cursor-pointer"}
            `}
            style={{ top: tops.get(thread.id) ?? thread.top }}
            onClick={() => {
              if (!active) comments.setActive(thread.id);
            }}
            onPointerEnter={() => comments.setHovered(thread.id)}
            onPointerLeave={() => comments.setHovered(null)}
          >
            <ThreadCard active={active} comments={comments} thread={thread} />
          </section>
        );
      })}
      {snapshot.draft ? (
        <section
          ref={cardRef(DRAFT_ID)}
          className={`${cardClassName} ${litCardClassName} z-10`}
          style={{ top: tops.get(DRAFT_ID) ?? snapshot.draft.top }}
        >
          <DraftCard comments={comments} draft={snapshot.draft} />
        </section>
      ) : null}
    </aside>
  );
}
