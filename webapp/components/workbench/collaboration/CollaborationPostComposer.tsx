/*
 * Exports:
 * - default CollaborationPostComposer: wrap ThreadComposer for Collaboration post create, reply, and edit drafts. Keywords: collaboration, post, composer, comment.
 */
"use client";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  ThreadPayload,
  WorkbenchHarness,
  WorkbenchThreadComposerAttachmentDraft,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ThreadComposer from "../thread-view/ThreadComposer";
import type { WorkbenchCollaborationPostDraft } from "../../../lib/workbench/collaboration/collaboration-tree-mutations";

function createComposerThread(id: string, harness: WorkbenchHarness, cwd: string): ThreadPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    createdAt: nowSeconds,
    cwd,
    forkedFromId: null,
    harness,
    id,
    isDraft: true,
    model: null,
    name: null,
    path: null,
    preview: "",
    reasoningEffort: null,
    serviceTier: null,
    source: "collaboration",
    status: "idle",
    tokenUsage: null,
    turnHistory: [],
    turns: [],
    unreadBadge: null,
    updatedAt: nowSeconds,
  };
}

function inputToDraft(input: readonly UserInput[]): WorkbenchCollaborationPostDraft {
  const text = input
    .flatMap((entry) => entry.type === "text" ? [entry.text] : [])
    .join("\n")
    .trim();
  const attachments: WorkbenchThreadComposerAttachmentDraft[] = input.flatMap((entry, index) => (
    entry.type === "image" ? [{ id: `composer-image:${index}:${entry.url}`, url: entry.url }] : []
  ));

  return {
    attachments,
    body: text,
  };
}

export default function CollaborationPostComposer ({
  composerSpellCheck,
  draft,
  harness,
  highlightSources,
  id,
  label,
  projectId,
  projectRootPath,
  surface = "card",
  workspaceRoots,
  onCancel,
  onSubmit,
}: {
  composerSpellCheck: boolean;
  draft?: WorkbenchThreadComposerDraft | null;
  harness: WorkbenchHarness;
  highlightSources: InlineMentionHighlightSources;
  id: string;
  label: string;
  projectId: string;
  projectRootPath: string;
  surface?: "bare" | "card";
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
  onCancel?: () => void;
  onSubmit: (draft: WorkbenchCollaborationPostDraft) => void;
}) {
  const thread = createComposerThread(id, harness, projectRootPath);
  const cancelButton = onCancel ? (
    <button
      type="button"
      className="inline-flex h-9 items-center rounded-full px-3 text-[0.78rem] font-semibold text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onCancel}
    >
      Cancel
    </button>
  ) : null;

  return (
    <div>
      <ThreadComposer
        autoExpandSavedDraftShelf={false}
        composerSpellCheck={composerSpellCheck}
        controlsMode="comment"
        highlightSources={highlightSources}
        knownSkills={[]}
        layout="inline"
        onListModels={async () => []}
        onPauseThread={() => { }}
        onResumeThread={() => { }}
        onSendMessage={async (_threadId, input) => {
          onSubmit(inputToDraft(input));
        }}
        onStopThread={() => { }}
        onSubmitUserInputRequest={async () => { }}
        onThreadAgentChange={() => { }}
        onThreadComposerDraftChange={() => { }}
        onThreadComposerDraftClear={() => { }}
        onThreadModelChange={() => { }}
        onThreadQuestionnaireDraftChange={() => { }}
        onThreadQuestionnaireDraftClear={() => { }}
        onThreadReasoningEffortChange={() => { }}
        onThreadSavedComposerDraftDelete={() => { }}
        onThreadSavedComposerDraftSave={() => { }}
        onThreadServiceTierChange={() => { }}
        pendingUserInputRequest={null}
        leadingActions={cancelButton}
        projectId={projectId}
        projectRootPath={projectRootPath}
        rateLimits={null}
        sendLabel={label}
        showSavedDraftControls={false}
        surface={surface}
        thread={thread}
        threadComposerDraft={draft ?? null}
        threadQuestionnaireDraft={null}
        threadSavedComposerDrafts={[]}
        workspaceRoots={workspaceRoots}
      />
    </div>
  );
}
