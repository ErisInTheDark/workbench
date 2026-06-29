/*
 * Exports:
 * - default CollaborationRevisionHistoryDialog: show post revisions and restore selected versions. Keywords: collaboration, revisions, dialog, restore.
 */
"use client";

import type { WorkbenchCollaborationPost } from "../../../lib/types";
import PrimaryButton from "../PrimaryButton";

function formatRevisionTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

export default function CollaborationRevisionHistoryDialog ({
  post,
  onClose,
  onRestore,
}: {
  post: WorkbenchCollaborationPost | null;
  onClose: () => void;
  onRestore: (revisionId: string) => void;
}) {
  if (!post) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Post revision history"
        className="max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-2xl overflow-hidden rounded-[1.35rem] bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] p-4 shadow-float"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="m-0 text-[1rem] font-semibold text-text">Revision history</h3>
            <p className="mt-1 mb-0 text-[0.82rem] text-muted">{post.revisions.length} saved version{post.revisions.length === 1 ? "" : "s"}</p>
          </div>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            onClick={onClose}
          >
            <span className="sr-only">Close revision history</span>
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
          </button>
        </div>
        <div className="explorer-scrollbar max-h-[32rem] space-y-3 overflow-y-auto pr-1">
          {post.revisions.map((revision) => (
            <article
              key={revision.id}
              className="rounded-[1rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted">
                  {revision.source} - {formatRevisionTimestamp(revision.createdAt)}
                </p>
                <PrimaryButton
                  type="button"
                  onClick={() => {
                    onRestore(revision.id);
                  }}
                >
                  Restore
                </PrimaryButton>
              </div>
              <p className="m-0 whitespace-pre-wrap text-[0.9rem] leading-6 text-text">{revision.body}</p>
              {revision.prompt ? (
                <p className="mt-3 mb-0 whitespace-pre-wrap rounded-[0.9rem] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] p-3 text-[0.84rem] leading-6 text-muted">
                  {revision.prompt}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
