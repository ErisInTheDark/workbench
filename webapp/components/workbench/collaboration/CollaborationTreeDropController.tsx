/*
 * Exports:
 * - default CollaborationTreeDropController: compute and render Collaboration post drop intent previews. Keywords: collaboration, drag, drop, tree.
 */
"use client";

import { useState, type PointerEvent, type ReactNode } from "react";

import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import type { CollaborationPostDropIntent } from "../../../lib/workbench/collaboration/collaboration-tree-mutations";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getIntentFromPointer(event: PointerEvent<HTMLElement>, targetPostId: string): CollaborationPostDropIntent {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = event.clientY - rect.top;
  if (y < rect.height * 0.28) {
    return { targetPostId, type: "before" };
  }
  if (y > rect.height * 0.72) {
    return { targetPostId, type: "after" };
  }
  return { targetPostId, type: "inside" };
}

function isNearestDropTarget(event: PointerEvent<HTMLElement>, postId: string) {
  if (!(event.target instanceof HTMLElement)) {
    return false;
  }

  return event.target.closest("[data-collaboration-drop-target-id]")?.getAttribute("data-collaboration-drop-target-id") === postId;
}

export default function CollaborationTreeDropController ({
  activeDrag,
  children,
  postId,
  onDrop,
}: {
  activeDrag: WorkbenchDragPayload | null;
  children: ReactNode;
  postId: string;
  onDrop: (postId: string, intent: CollaborationPostDropIntent) => void;
}) {
  const [intent, setIntent] = useState<CollaborationPostDropIntent | null>(null);
  const isDraggingPost = activeDrag?.type === "collaboration-post" && activeDrag.postId !== postId;

  return (
    <div
      data-collaboration-drop-target-id={postId}
      className={joinClasses(
        "relative",
        isDraggingPost && intent?.type === "inside" && "rounded-[1.15rem] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]",
      )}
      onPointerMove={(event) => {
        if (!isDraggingPost) {
          return;
        }

        if (!isNearestDropTarget(event, postId)) {
          setIntent(null);
          return;
        }

        setIntent(getIntentFromPointer(event, postId));
      }}
      onPointerLeave={() => {
        setIntent(null);
      }}
      onPointerUp={(event) => {
        if (!isDraggingPost || !intent) {
          return;
        }

        if (!isNearestDropTarget(event, postId)) {
          setIntent(null);
          return;
        }

        onDrop(activeDrag.postId, intent);
        setIntent(null);
      }}
    >
      {isDraggingPost && intent?.type === "before" ? (
        <div className="pointer-events-none absolute -top-1 left-0 right-0 z-10 h-0.5 rounded-full bg-accent" aria-hidden="true" />
      ) : null}
      {children}
      {isDraggingPost && intent?.type === "after" ? (
        <div className="pointer-events-none absolute -bottom-1 left-0 right-0 z-10 h-0.5 rounded-full bg-accent" aria-hidden="true" />
      ) : null}
    </div>
  );
}
