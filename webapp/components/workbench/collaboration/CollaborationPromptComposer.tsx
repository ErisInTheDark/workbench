/*
 * Exports:
 * - default CollaborationPromptComposer: adapt ThreadComposer for starting prompt-bearing Collaboration posts as Workbench threads. Keywords: collaboration, prompt, composer, thread start.
 */
"use client";

import { useEffect, type ComponentProps } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  ThreadPayload,
  WorkbenchCollaborationPost,
  WorkbenchComposerSettings,
  WorkbenchQuestionnaireDraft,
  WorkbenchThreadComposerDraft,
} from "../../../lib/types";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ThreadComposer from "../thread-view/ThreadComposer";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileProvider";

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
  onThreadHarnessToggle,
  onThreadModelChange,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadReasoningEffortChange,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onThreadServiceTierChange,
  onThreadSettingsChange,
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
  onThreadHarnessToggle: (postId: string, threadId: string) => void;
  onThreadModelChange: (postId: string, threadId: string, model: string) => void;
  onThreadQuestionnaireDraftChange: (threadId: string, requestKey: string, draft: WorkbenchQuestionnaireDraft) => void;
  onThreadQuestionnaireDraftClear: (threadId: string, requestKey: string) => void;
  onThreadReasoningEffortChange: (postId: string, threadId: string, reasoningEffort: string | null) => void;
  onThreadSavedComposerDraftDelete: ThreadComposerProps["onThreadSavedComposerDraftDelete"];
  onThreadSavedComposerDraftSave: ThreadComposerProps["onThreadSavedComposerDraftSave"];
  onThreadServiceTierChange: (postId: string, threadId: string, serviceTier: string | null) => void;
  onThreadSettingsChange: (postId: string, threadId: string, settings: WorkbenchComposerSettings) => void;
}) {
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const profileSlot = { kind: "new-thread" as const, projectId };
  const resolvedThread = composerProfileController.resolveThread(profileSlot, thread);

  useEffect(() => {
    const selection = composerProfileController.getSelection(profileSlot);
    if (selection.kind !== "custom" || !selection.pendingSettings) {
      return;
    }
    onThreadSettingsChange(post.id, thread.id, selection.pendingSettings);
    composerProfileController.acknowledgePendingSettings(profileSlot);
  }, [composerProfileController, composerProfileSnapshot, onThreadSettingsChange, post.id, projectId, thread.id]);

  return (
    <div data-collaboration-no-drag="true">
      <ThreadComposer
        canToggleHarness={thread.isDraft}
        composerSpellCheck={composerSpellCheck}
        highlightSources={highlightSources}
        knownSkills={[]}
        layout="inline"
        onListModels={onListModels}
        onHarnessToggle={() => onThreadHarnessToggle(post.id, thread.id)}
        onPauseThread={() => { }}
        onResumeThread={() => { }}
        onSendMessage={async (threadId, input) => {
          if (threadId !== thread.id) {
            throw new Error("Prompt draft is not ready.");
          }

          await onStartPromptThread(post.id, input, resolvedThread);
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
        onThreadSettingsChange={(threadId, settings) => {
          onThreadSettingsChange(post.id, threadId, settings);
        }}
        pendingUserInputRequest={null}
        projectId={projectId}
        projectRootPath={projectRootPath}
        profileSlot={profileSlot}
        rateLimits={rateLimits}
        sendLabel={post.promptThreadId ? "Open thread" : "Start"}
        showSavedDraftControls={false}
        surface="bare"
        thread={resolvedThread}
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
