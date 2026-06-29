/*
 * Exports:
 * - default CollaborationPromptComposer: adapt ThreadComposer for starting prompt-bearing Collaboration posts as Workbench threads. Keywords: collaboration, prompt, composer, thread start.
 */
"use client";

import type { ComponentProps } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  ThreadPayload,
  WorkbenchCollaborationPost,
  WorkbenchQuestionnaireDraft,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ThreadComposer from "../thread-view/ThreadComposer";

type ThreadComposerProps = ComponentProps<typeof ThreadComposer>;

export default function CollaborationPromptComposer ({
  composerSpellCheck,
  draft,
  error,
  highlightSources,
  post,
  projectId,
  projectRootPath,
  rateLimits,
  thread,
  workspaceRoots,
  onDraftChange,
  onDraftClear,
  onListModels,
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
}: {
  composerSpellCheck: boolean;
  draft: WorkbenchThreadComposerDraft | null;
  error: string;
  highlightSources: InlineMentionHighlightSources;
  post: WorkbenchCollaborationPost;
  projectId: string;
  projectRootPath: string;
  rateLimits: ThreadComposerProps["rateLimits"];
  thread: ThreadPayload;
  workspaceRoots: readonly WorkspaceFileLinkRoot[];
  onDraftChange: (postId: string, draft: WorkbenchThreadComposerDraft) => void;
  onDraftClear: (postId: string) => void;
  onListModels: ThreadComposerProps["onListModels"];
  onStartPromptThread: (postId: string, input: UserInput[], thread: ThreadPayload) => Promise<void>;
  onSubmitUserInputRequest: ThreadComposerProps["onSubmitUserInputRequest"];
  onThreadAgentChange: (postId: string, threadId: string, agentPath: string | null) => void;
  onThreadModelChange: (postId: string, threadId: string, model: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadReasoningEffortChange: (postId: string, threadId: string, reasoningEffort: string | null) => void;
  onThreadSavedComposerDraftDelete: ThreadComposerProps["onThreadSavedComposerDraftDelete"];
  onThreadSavedComposerDraftSave: ThreadComposerProps["onThreadSavedComposerDraftSave"];
  onThreadServiceTierChange: (postId: string, threadId: string, serviceTier: string | null) => void;
}) {
  return (
    <div data-collaboration-no-drag="true">
      <ThreadComposer
        composerSpellCheck={composerSpellCheck}
        highlightSources={highlightSources}
        knownSkills={[]}
        layout="inline"
        onListModels={onListModels}
        onPauseThread={() => { }}
        onResumeThread={() => { }}
        onSendMessage={async (threadId, input) => {
          if (threadId !== thread.id) {
            throw new Error("Prompt draft is not ready.");
          }

          await onStartPromptThread(post.id, input, thread);
        }}
        onStopThread={() => { }}
        onSubmitUserInputRequest={onSubmitUserInputRequest}
        onThreadAgentChange={(threadId, agentPath) => {
          onThreadAgentChange(post.id, threadId, agentPath);
        }}
        onThreadComposerDraftChange={(_threadId, nextDraft) => {
          onDraftChange(post.id, nextDraft);
        }}
        onThreadComposerDraftClear={() => {
          onDraftClear(post.id);
        }}
        onThreadModelChange={(threadId, model) => {
          onThreadModelChange(post.id, threadId, model);
        }}
        onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
        onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
        onThreadReasoningEffortChange={(threadId, reasoningEffort) => {
          onThreadReasoningEffortChange(post.id, threadId, reasoningEffort);
        }}
        onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
        onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
        onThreadServiceTierChange={(threadId, serviceTier) => {
          onThreadServiceTierChange(post.id, threadId, serviceTier);
        }}
        pendingUserInputRequest={null}
        projectId={projectId}
        projectRootPath={projectRootPath}
        rateLimits={rateLimits}
        sendLabel={post.promptThreadId ? "Open thread" : "Start"}
        showSavedDraftControls={false}
        surface="bare"
        thread={thread}
        threadComposerDraft={draft ?? {
          attachments: [],
          text: post.prompt ?? "",
          updatedAt: post.updatedAt,
        }}
        threadQuestionnaireDraft={null}
        threadSavedComposerDrafts={[]}
        workspaceRoots={workspaceRoots}
      />
      {error ? (
        <p className="mt-2 mb-0 px-1 text-[0.84rem] leading-5 text-danger">{error}</p>
      ) : null}
    </div>
  );
}
