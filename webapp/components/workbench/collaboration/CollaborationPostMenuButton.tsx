/*
 * Exports:
 * - default CollaborationPostMenuButton: open post actions from a vertical menu button. Keywords: collaboration, post, menu, context.
 * - Local helpers: render Collaboration post context menu icons. Keywords: collaboration, post, menu, icons.
 */
"use client";

import type { MouseEvent } from "react";

import type { WorkbenchCollaborationPost } from "../../../lib/types";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuProvider";
import { FileDeleteIcon, FileUpdateIcon } from "../workbench-icons";

function HistoryIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true" className="size-4">
      <path d="M5.6 5.35A6.25 6.25 0 1 1 4.1 8.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 5.75H5.9V7.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 6.75V10.35L12.35 12.05" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OpenThreadIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true" className="size-4">
      <path d="M4.25 4.75H15.75V13.25H8.25L4.25 16.25V4.75Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.25 8H12.75M7.25 10.5H10.75" strokeLinecap="round" />
    </svg>
  );
}

export default function CollaborationPostMenuButton ({
  post,
  onDelete,
  onEdit,
  onOpenHistory,
  onOpenPromptThread,
}: {
  post: WorkbenchCollaborationPost;
  onDelete: () => void;
  onEdit: () => void;
  onOpenHistory: () => void;
  onOpenPromptThread: () => void;
}) {
  const { openContextMenu } = useWorkbenchContextMenu();

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu({
      menu: {
        id: `collaboration-post:${post.id}`,
        label: "Post actions",
        items: [
          {
            id: "edit",
            label: "Edit",
            icon: <FileUpdateIcon className="size-4" />,
            onSelect: onEdit,
          },
          ...(post.revisions.length ? [{
            id: "history",
            label: "History",
            icon: <HistoryIcon />,
            onSelect: onOpenHistory,
          }] : []),
          ...(post.promptThreadId ? [{
            id: "open-prompt-thread",
            label: "Open prompt thread",
            icon: <OpenThreadIcon />,
            onSelect: onOpenPromptThread,
          }] : []),
          {
            id: "delete",
            label: "Delete",
            icon: <FileDeleteIcon className="size-4" />,
            onSelect: onDelete,
            tone: "danger",
          },
        ],
      },
      x: rect.right,
      y: rect.bottom + 4,
    });
  };

  return (
    <button
      type="button"
      aria-label="Open post actions"
      title="Post actions"
      className="inline-flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={openMenu}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
        <path d="M8 3.1h.01M8 8h.01M8 12.9h.01" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
      </svg>
    </button>
  );
}
