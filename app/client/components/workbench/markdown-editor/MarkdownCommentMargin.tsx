/*
 * Exports:
 * - default MarkdownCommentMargin: comment threads beside the markdown editor: cards aligned to what they discuss,
 *   pushed apart so they never overlap and flowing around suggestion rows, or inline badges that open a card where the pane is too narrow. Notes are
 *   always editable and save as typed; a focused thread offers an empty row signed with the configured name that
 *   becomes a note on its first character, and a draft card does the same for a new thread.
 */
"use client";

import {
  createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { COMMENT_AUTHOR_MAX_LENGTH, type MarkdownComment } from "../../../workbench/markdown/comment-markdown";
import type {
  CommentDraftView,
  CommentMarginSnapshot,
  CommentThreadView,
} from "../../../workbench/editor/WorkbenchCommentController";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import FlushInput from "../../ui/FlushInput";
import FlushTextArea from "../../ui/FlushTextArea";
import IconButton from "../../ui/IconButton";
import { CheckIcon, MessageSquareTextIcon, Trash2Icon } from "../workbench-icons";
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

/** What an author field may hold while typing; trimming waits for the comment to be written. */
function authorInput(value: string) {
  return value.replace(/[\]\r\n]+/gu, "");
}

function AuthorField({ onCommit, value }: { onCommit: (author: string) => void; value: string }) {
  return (
    <FlushInput
      ariaLabel="Comment author"
      placeholder="User"
      maxLength={COMMENT_AUTHOR_MAX_LENGTH}
      normalize={authorInput}
      value={value}
      className="w-full pr-8 text-[0.76rem] font-semibold text-text"
      onCommit={onCommit}
    />
  );
}

const bodyClassName = "text-[0.86rem] leading-snug text-text";

/**
 * Where typing should continue once the comment it just created renders: a note of a thread, or of the active thread
 * when a draft became one.
 */
interface FocusRequest {
  index: number;
  threadId: string | null;
}

const CommentFocusContext = createContext<{ current: FocusRequest | null }>({ current: null });

/** One note, always editable: its body saves as it is typed, and leaving it empty deletes it. */
function CommentEntry({
  comment,
  focusOnMount,
  onDelete,
  onEdit,
}: {
  comment: MarkdownComment;
  focusOnMount: boolean;
  onDelete: () => void;
  onEdit: (edit: { author: string | null; body: string }) => void;
}) {
  const focusRequest = useContext(CommentFocusContext);
  useEffect(() => {
    if (focusOnMount) focusRequest.current = null;
  }, []);
  return (
    <div className="group/comment relative py-1">
      <AuthorField value={comment.author ?? ""} onCommit={(author) => onEdit({ author: author || null, body: comment.body })} />
      <FlushTextArea
        ariaLabel="Comment"
        value={comment.body}
        focusOnMount={focusOnMount}
        className={bodyClassName}
        onChange={(body) => {
          if (body.trim()) onEdit({ author: comment.author, body });
        }}
        onLeave={(body) => {
          if (!body.trim()) onDelete();
        }}
      />
      <span className="absolute top-0.5 right-0 flex opacity-0 transition-opacity group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 coarse-touch:opacity-100">
        <IconButton label="Delete comment" size="compact" display="hover-border" tone="danger" onClick={onDelete}>
          <Trash2Icon size={14} />
        </IconButton>
      </span>
    </div>
  );
}

/**
 * The empty row under a thread, signed with the configured name: its first typed character makes it a real note, typing
 * carries on in that note, and a fresh empty row takes this one's place.
 */
function NewCommentEntry({
  autoFocus = false,
  defaultAuthor,
  focusTarget,
  onCancel,
  onSubmit,
  placeholder,
}: {
  autoFocus?: boolean;
  defaultAuthor: string;
  /** The note this row becomes once typed into. */
  focusTarget: FocusRequest;
  onCancel: () => void;
  onSubmit: (body: string, author: string | null) => void;
  placeholder: string;
}) {
  const [author, setAuthor] = useState(defaultAuthor);
  const focusRequest = useContext(CommentFocusContext);
  return (
    <div className="py-1">
      <AuthorField value={author} onCommit={setAuthor} />
      <FlushTextArea
        ariaLabel={placeholder}
        focusOnMount={autoFocus}
        placeholder={placeholder}
        value=""
        className={bodyClassName}
        onChange={(body) => {
          if (!body.trim()) return;
          focusRequest.current = focusTarget;
          onSubmit(body, author || null);
        }}
        onEscape={onCancel}
      />
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

function ThreadCard({
  active,
  comments,
  defaultAuthor,
  thread,
}: {
  active: boolean;
  comments: Comments;
  defaultAuthor: string;
  thread: CommentThreadView;
}) {
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
  const focusRequest = useContext(CommentFocusContext).current;
  const focusIndex = focusRequest && (focusRequest.threadId ?? (active ? thread.id : null)) === thread.id
    ? focusRequest.index : -1;
  const entries = (
    <div className="flex min-w-0 flex-1 flex-col [&>*+*]:(border-t border-fg-alpha/8)">
      {thread.comments.map((comment, index) => (
        <CommentEntry
          key={index}
          comment={comment}
          focusOnMount={index === focusIndex}
          onDelete={() => comments.deleteComment(thread.id, index)}
          onEdit={(edit) => comments.editComment(thread.id, index, edit)}
        />
      ))}
      {active ? (
        <NewCommentEntry
          key={`reply-${thread.comments.length}`}
          defaultAuthor={defaultAuthor}
          focusTarget={{ index: thread.comments.length, threadId: thread.id }}
          placeholder="Reply"
          onCancel={() => comments.setActive(null)}
          onSubmit={(body, author) => comments.reply(thread.id, body, author)}
        />
      ) : null}
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
    </>
  );
}

function DraftCard({ comments, defaultAuthor, draft }: { comments: Comments; defaultAuthor: string; draft: CommentDraftView }) {
  return (
    <>
      {draft.quote ? <CardHeader quote={draft.quote} /> : null}
      <NewCommentEntry
        autoFocus
        defaultAuthor={defaultAuthor}
        focusTarget={{ index: 0, threadId: null }}
        placeholder="Add a comment"
        onCancel={() => comments.cancelDraft()}
        onSubmit={(body, author) => comments.submitDraft(body, author)}
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
  defaultAuthor,
  layout,
}: {
  client: WorkbenchFilePanelClient | null;
  /** The configured name that signs new comments; empty leaves them unsigned. */
  defaultAuthor: string;
  layout: CommentMarginLayout;
}) {
  const comments = client?.comments ?? null;
  const snapshot = useSyncExternalStore(comments?.subscribe ?? noSubscription, comments?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const cards = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const focusRequest = useRef<FocusRequest | null>(null);

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
      <CommentFocusContext.Provider value={focusRequest}>
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
            {snapshot.draft ? <DraftCard comments={comments} defaultAuthor={defaultAuthor} draft={snapshot.draft} /> : (
              <ThreadCard
                active
                comments={comments}
                defaultAuthor={defaultAuthor}
                thread={snapshot.threads.find((thread) => thread.id === open.id)!}
              />
            )}
          </section>
        ) : null}
      </div>
      </CommentFocusContext.Provider>
    );
  }

  const items: PlacedItem[] = [
    ...snapshot.threads.map(({ id, top }) => ({ id, top })),
    ...(snapshot.draft ? [{ id: DRAFT_ID, top: snapshot.draft.top }] : []),
  ];
  const tops = placeCards(items, heights, snapshot.draft ? DRAFT_ID : snapshot.activeId, snapshot.obstacles);

  return (
    <CommentFocusContext.Provider value={focusRequest}>
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
            <ThreadCard active={active} comments={comments} defaultAuthor={defaultAuthor} thread={thread} />
          </section>
        );
      })}
      {snapshot.draft ? (
        <section
          ref={cardRef(DRAFT_ID)}
          className={`${cardClassName} ${litCardClassName} z-10`}
          style={{ top: tops.get(DRAFT_ID) ?? snapshot.draft.top }}
        >
          <DraftCard comments={comments} defaultAuthor={defaultAuthor} draft={snapshot.draft} />
        </section>
      ) : null}
    </aside>
    </CommentFocusContext.Provider>
  );
}
