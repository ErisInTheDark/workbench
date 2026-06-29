/*
 * Exports:
 * - default CollaborationThreadedView: render Collaboration post roots, root composer, and empty state inside the discussion panel. Keywords: collaboration, threaded view, tree.
 */
"use client";

import type { ComponentProps, PointerEvent as ReactPointerEvent } from "react";

import type {
  ThreadPayload,
  WorkbenchCollaborationPost,
  WorkbenchCollaborationState,
  WorkbenchHarness,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import type {
  CollaborationPostDropIntent,
  WorkbenchCollaborationPostDraft,
} from "../../../lib/workbench/collaboration/collaboration-tree-mutations";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import CollaborationPostComposer from "./CollaborationPostComposer";
import CollaborationPostNode from "./CollaborationPostNode";
import CollaborationPromptComposer from "./CollaborationPromptComposer";

type CollaborationPromptComposerProps = ComponentProps<typeof CollaborationPromptComposer>;

export default function CollaborationThreadedView ({
  activeDrag,
  composerSpellCheck,
  harness,
  highlightSources,
  projectId,
  projectRootPath,
  promptComposerDraftsByPostId,
  promptDraftThreadsByPostId,
  promptStartErrorsByPostId,
  rateLimits,
  state,
  workspaceRoots,
  onCreatePost,
  onDeletePost,
  onEditPost,
  onEnsurePromptDraftThread,
  onMovePost,
  onOpenPromptThread,
  onOpenRevisionHistory,
  onPostPointerDragStart,
  onPromptDraftChange,
  onPromptDraftClear,
  onStartPromptThread,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadModelChange,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadReasoningEffortChange,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onThreadServiceTierChange,
  onListModels,
}: {
  activeDrag: WorkbenchDragPayload | null;
  composerSpellCheck: boolean;
  harness: WorkbenchHarness;
  highlightSources: InlineMentionHighlightSources;
  projectId: string;
  projectRootPath: string;
  promptComposerDraftsByPostId: Record<string, WorkbenchThreadComposerDraft | undefined>;
  promptDraftThreadsByPostId: Record<string, ThreadPayload | undefined>;
  promptStartErrorsByPostId: Record<string, string | undefined>;
  rateLimits: CollaborationPromptComposerProps["rateLimits"];
  state: WorkbenchCollaborationState;
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
  onCreatePost: (parentId: string | null, draft: WorkbenchCollaborationPostDraft) => void;
  onDeletePost: (postId: string) => void;
  onEditPost: (postId: string, draft: WorkbenchCollaborationPostDraft) => void;
  onEnsurePromptDraftThread: (post: WorkbenchCollaborationPost) => ThreadPayload | null;
  onMovePost: (postId: string, intent: CollaborationPostDropIntent) => void;
  onOpenPromptThread: (threadId: string) => void;
  onOpenRevisionHistory: (postId: string) => void;
  onPostPointerDragStart: (event: ReactPointerEvent<HTMLElement>, post: WorkbenchCollaborationPost) => void;
  onPromptDraftChange: CollaborationPromptComposerProps["onDraftChange"];
  onPromptDraftClear: CollaborationPromptComposerProps["onDraftClear"];
  onStartPromptThread: CollaborationPromptComposerProps["onStartPromptThread"];
  onSubmitUserInputRequest: CollaborationPromptComposerProps["onSubmitUserInputRequest"];
  onThreadAgentChange: CollaborationPromptComposerProps["onThreadAgentChange"];
  onThreadModelChange: CollaborationPromptComposerProps["onThreadModelChange"];
  onThreadQuestionnaireDraftChange: CollaborationPromptComposerProps["onThreadQuestionnaireDraftChange"];
  onThreadQuestionnaireDraftClear: CollaborationPromptComposerProps["onThreadQuestionnaireDraftClear"];
  onThreadReasoningEffortChange: CollaborationPromptComposerProps["onThreadReasoningEffortChange"];
  onThreadSavedComposerDraftDelete: CollaborationPromptComposerProps["onThreadSavedComposerDraftDelete"];
  onThreadSavedComposerDraftSave: CollaborationPromptComposerProps["onThreadSavedComposerDraftSave"];
  onThreadServiceTierChange: CollaborationPromptComposerProps["onThreadServiceTierChange"];
  onListModels: CollaborationPromptComposerProps["onListModels"];
}) {
  const rootPosts = state.rootPostIds.map((postId) => state.posts[postId]).filter((post): post is WorkbenchCollaborationPost => Boolean(post));

  return (
    <div className="explorer-scrollbar h-full min-h-0 overflow-y-auto">
      <div className="flex min-h-full w-full flex-col gap-5 px-5 py-5 md:px-6">
        <CollaborationPostComposer
          composerSpellCheck={composerSpellCheck}
          harness={harness}
          highlightSources={highlightSources}
          id="collaboration-root-composer"
          label="Post thread"
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
          onSubmit={(draft) => {
            onCreatePost(null, draft);
          }}
        />
        {rootPosts.length ? (
          <section className="space-y-1">
            {rootPosts.map((post) => (
              <CollaborationPostNode
                key={post.id}
                activeDrag={activeDrag}
                composerSpellCheck={composerSpellCheck}
                harness={harness}
                highlightSources={highlightSources}
                post={post}
                projectId={projectId}
                projectRootPath={projectRootPath}
                promptComposerDraftsByPostId={promptComposerDraftsByPostId}
                promptDraftThreadsByPostId={promptDraftThreadsByPostId}
                promptStartErrorsByPostId={promptStartErrorsByPostId}
                rateLimits={rateLimits}
                state={state}
                workspaceRoots={workspaceRoots}
                onCreatePost={onCreatePost}
                onDeletePost={onDeletePost}
                onEditPost={onEditPost}
                onEnsurePromptDraftThread={onEnsurePromptDraftThread}
                onMovePost={onMovePost}
                onOpenPromptThread={onOpenPromptThread}
                onOpenRevisionHistory={onOpenRevisionHistory}
                onPostPointerDragStart={onPostPointerDragStart}
                onPromptDraftChange={onPromptDraftChange}
                onPromptDraftClear={onPromptDraftClear}
                onStartPromptThread={onStartPromptThread}
                onSubmitUserInputRequest={onSubmitUserInputRequest}
                onThreadAgentChange={onThreadAgentChange}
                onThreadModelChange={onThreadModelChange}
                onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
                onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
                onThreadReasoningEffortChange={onThreadReasoningEffortChange}
                onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
                onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
                onThreadServiceTierChange={onThreadServiceTierChange}
                onListModels={onListModels}
              />
            ))}
          </section>
        ) : (
          <section className="rounded-[1.35rem] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] p-5">
            <p className="m-0 text-[1rem] font-semibold text-text">No posts yet</p>
            <p className="mt-1 mb-0 text-[0.9rem] leading-6 text-muted">Start a thread above, or run the collaborator after adding context.</p>
          </section>
        )}
      </div>
    </div>
  );
}
