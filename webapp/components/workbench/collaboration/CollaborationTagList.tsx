/*
 * Exports:
 * - default CollaborationTagList: render project and post Collaboration tag pills with inline add/remove controls. Keywords: collaboration, tags, pills, add, remove, inline.
 * - Local helpers: class joining and tag keys. Keywords: classes, tag.
 */
"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { normalizeWorkbenchCollaborationTag } from "../../../lib/workbench/collaboration/collaboration-state";
import { TagAddIcon, TagCheckIcon } from "../workbench-icons";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getTagKey(tag: string) {
  return tag.toLocaleLowerCase();
}

function TagPill ({
  canRemove = false,
  tag,
  onRemove,
}: {
  canRemove?: boolean;
  tag: string;
  onRemove?: (tag: string) => void;
}) {
  return (
    <span
      className={joinClasses(
        "group/tag relative inline-flex min-w-0 items-center rounded-full px-2 py-0.5 text-[0.72rem] font-medium leading-5",
        "bg-[color-mix(in_srgb,var(--text)_5%,transparent)] text-muted",
        canRemove && "pr-5",
      )}
    >
      <span className="min-w-0 truncate">{tag}</span>
      {canRemove ? (
        <button
          type="button"
          aria-label={`Remove ${tag} tag`}
          title={`Remove ${tag}`}
          className="absolute inset-y-0 right-0 inline-flex w-5 items-center justify-center rounded-full text-muted opacity-0 transition hover:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft group-hover/tag:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.(tag);
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </span>
  );
}

export default function CollaborationTagList ({
  allTags,
  assignedTags,
  className,
  label,
  variant,
  onAddTag,
  onCreateTag,
  onRemoveTag,
}: {
  allTags: readonly string[];
  assignedTags?: readonly string[];
  className?: string;
  label: string;
  variant: "catalog" | "post";
  onAddTag?: (tag: string) => void;
  onCreateTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const editableRef = useRef<HTMLSpanElement | null>(null);
  const visibleTags = variant === "post" ? assignedTags ?? [] : allTags;
  const canRemove = variant === "post" && Boolean(onRemoveTag);
  const placeholder = variant === "post" ? "Tag post" : "New tag";

  useEffect(() => {
    if (!isAdding) {
      return;
    }

    const editable = editableRef.current;
    if (!editable) {
      return;
    }

    editable.textContent = "";
    editable.focus();
  }, [isAdding]);

  const submitTag = (value: string) => {
    const tag = normalizeWorkbenchCollaborationTag(value);
    if (!tag) {
      return;
    }

    if (variant === "post") {
      onAddTag?.(tag);
    } else {
      onCreateTag?.(tag);
    }
    setDraft("");
    setIsAdding(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitTag(draft);
  };

  const handleEditableKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submitTag(draft);
      return;
    }

    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDraft("");
    setIsAdding(false);
  };

  return (
    <div className={joinClasses("relative flex min-w-0 flex-wrap items-center gap-1.5", className)} data-collaboration-no-drag="true">
      <span className="sr-only">{label}</span>
      {visibleTags.length ? visibleTags.map((tag) => (
        <TagPill
          key={getTagKey(tag)}
          canRemove={canRemove}
          tag={tag}
          onRemove={onRemoveTag}
        />
      )) : variant === "catalog" ? (
        <span className="text-[0.74rem] font-medium text-muted/75">No tags yet</span>
      ) : null}
      {isAdding ? (
        <form
          className="inline-flex h-6 min-w-0 max-w-[13rem] items-center rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] pl-2 pr-0.5"
          onSubmit={handleSubmit}
        >
          <span
            ref={editableRef}
            aria-label={placeholder}
            contentEditable="plaintext-only"
            data-empty={draft ? "false" : "true"}
            data-placeholder={placeholder}
            role="textbox"
            suppressContentEditableWarning
            className="inline-block min-w-[2ch] max-w-[10rem] overflow-hidden whitespace-nowrap bg-transparent text-[0.72rem] font-medium leading-5 text-text outline-none before:pointer-events-none before:text-muted/70 data-[empty=true]:min-w-[4.5rem] data-[empty=true]:before:content-[attr(data-placeholder)]"
            onClick={(event) => {
              event.stopPropagation();
            }}
            onInput={(event) => {
              setDraft(event.currentTarget.textContent ?? "");
            }}
            onKeyDown={handleEditableKeyDown}
          />
          <button
            type="submit"
            aria-label="Save tag"
            title="Save tag"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-accent transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <TagCheckIcon className="size-3.5" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          aria-label={variant === "post" ? "Add tag to post" : "Create tag"}
          title={variant === "post" ? "Add tag to post" : "Create tag"}
          className="inline-flex size-6 items-center justify-center rounded-full text-[0.8rem] font-semibold text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          onClick={(event) => {
            event.stopPropagation();
            setIsAdding((current) => !current);
          }}
        >
          <TagAddIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
