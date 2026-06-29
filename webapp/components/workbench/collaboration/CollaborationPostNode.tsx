/*
 * Exports:
 * - default CollaborationPostNode: render one recursive Collaboration post branch with single-surface post, prompt, edit, and reply modes. Keywords: collaboration, post, tree, recursive, prompt.
 * - Local helpers: draft conversion, action buttons, and drag-start filtering. Keywords: collaboration, composer, drag, prompt.
 */
"use client";

import { useMemo, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";

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
import CollaborationPostMenuButton from "./CollaborationPostMenuButton";
import CollaborationPostSurface from "./CollaborationPostSurface";
import CollaborationPromptComposer from "./CollaborationPromptComposer";
import CollaborationTreeDropController from "./CollaborationTreeDropController";
import PrimaryButton from "../PrimaryButton";
import ThreadMarkdown from "../thread-view/ThreadMarkdown";

type CollaborationPostMode = "edit-post" | "prompt" | "reply" | null;
type CollaborationPromptComposerProps = ComponentProps<typeof CollaborationPromptComposer>;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function draftFromPost(post: WorkbenchCollaborationPost): WorkbenchThreadComposerDraft {
  return {
    attachments: post.attachments ?? [],
    text: post.body,
    updatedAt: post.updatedAt,
  };
}

function shouldIgnorePostDragStart(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || !(event.target instanceof HTMLElement)) {
    return true;
  }

  return Boolean(event.target.closest("button,a,input,textarea,select,[contenteditable='true'],[role='button'],[data-collaboration-no-drag='true']"));
}

function CollapsePromptButton ({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Collapse prompt"
      title="Collapse prompt"
      className="inline-flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <path d="M4 8h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    </button>
  );
}

function PostReplyButton ({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center rounded-full px-2 text-[0.78rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      data-collaboration-no-drag="true"
      onClick={onClick}
    >
      Reply
    </button>
  );
}

export default function CollaborationPostNode ({
  activeDrag,
  composerSpellCheck,
  depth = 0,
  harness,
  highlightSources,
  post,
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
  onThreadAgentChange,
  onThreadModelChange,
  onThreadQuestionnaireDraftChange,
  onThreadQuestionnaireDraftClear,
  onThreadReasoningEffortChange,
  onThreadSavedComposerDraftDelete,
  onThreadSavedComposerDraftSave,
  onThreadServiceTierChange,
  onListModels,
  onSubmitUserInputRequest,
}: {
  activeDrag: WorkbenchDragPayload | null;
  composerSpellCheck: boolean;
  depth?: number;
  harness: WorkbenchHarness;
  highlightSources: InlineMentionHighlightSources;
  post: WorkbenchCollaborationPost;
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
  onThreadAgentChange: CollaborationPromptComposerProps["onThreadAgentChange"];
  onThreadModelChange: CollaborationPromptComposerProps["onThreadModelChange"];
  onThreadQuestionnaireDraftChange: CollaborationPromptComposerProps["onThreadQuestionnaireDraftChange"];
  onThreadQuestionnaireDraftClear: CollaborationPromptComposerProps["onThreadQuestionnaireDraftClear"];
  onThreadReasoningEffortChange: CollaborationPromptComposerProps["onThreadReasoningEffortChange"];
  onThreadSavedComposerDraftDelete: CollaborationPromptComposerProps["onThreadSavedComposerDraftDelete"];
  onThreadSavedComposerDraftSave: CollaborationPromptComposerProps["onThreadSavedComposerDraftSave"];
  onThreadServiceTierChange: CollaborationPromptComposerProps["onThreadServiceTierChange"];
  onListModels: CollaborationPromptComposerProps["onListModels"];
  onSubmitUserInputRequest: CollaborationPromptComposerProps["onSubmitUserInputRequest"];
}) {
  const [mode, setMode] = useState<CollaborationPostMode>(null);
  const childPosts = useMemo(() => post.childIds.map((childId) => state.posts[childId]).filter((child): child is WorkbenchCollaborationPost => Boolean(child)), [post.childIds, state.posts]);
  const authorLabel = post.author === "agent" ? "Agent" : "User";
  const canDragPost = mode !== "edit-post" && mode !== "prompt";
  const promptDraftThread = promptDraftThreadsByPostId[post.id] ?? null;
  const isPromptPost = Boolean(post.prompt);
  const isPromptOpen = mode === "prompt";

  const openPromptComposer = () => {
    if (!post.prompt) {
      return;
    }

    if (!post.promptThreadId) {
      onEnsurePromptDraftThread(post);
    }

    setMode("prompt");
  };

  const primaryAction = isPromptOpen ? (
    <CollapsePromptButton onClick={() => { setMode(null); }} />
  ) : null;

  const renderedPostBody = (
    <>
      <ThreadMarkdown
        className="text-[0.95rem] text-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        inlineMentionSources={highlightSources}
        markdown={post.body}
        projectId={projectId}
        projectRootPath={projectRootPath}
        threadCwdPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
      {post.attachments?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {post.attachments.map((attachment, index) => (
            <img
              key={attachment.id}
              alt={`Post attachment ${index + 1}`}
              className="h-20 w-20 rounded-[0.9rem] object-cover"
              src={attachment.url}
            />
          ))}
        </div>
      ) : null}
    </>
  );

  const bodyContent = mode === "edit-post" ? (
    <div data-collaboration-no-drag="true">
      <CollaborationPostComposer
        composerSpellCheck={composerSpellCheck}
        draft={draftFromPost(post)}
        harness={harness}
        highlightSources={highlightSources}
        id={`collaboration-edit:${post.id}`}
        label="Save"
        projectId={projectId}
        projectRootPath={projectRootPath}
        surface="bare"
        workspaceRoots={workspaceRoots}
        onCancel={() => {
          setMode(null);
        }}
        onSubmit={(draft) => {
          onEditPost(post.id, {
            ...draft,
            prompt: post.prompt,
          });
          setMode(null);
        }}
      />
    </div>
  ) : isPromptOpen && post.prompt ? (
    <>
      {renderedPostBody}
      {post.promptThreadId ? (
        <div className="mt-3 flex justify-end" data-collaboration-no-drag="true">
          <PrimaryButton
            type="button"
            onClick={() => {
              if (post.promptThreadId) {
                onOpenPromptThread(post.promptThreadId);
              }
            }}
          >
            Open thread
          </PrimaryButton>
        </div>
      ) : (
        <div className="relative mt-2 pl-[0.9rem]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[3.25rem] left-0 top-1 w-[0.18rem] rounded-full bg-[color-mix(in_srgb,var(--text)_14%,transparent)]"
          />
          {promptDraftThread ? (
            <CollaborationPromptComposer
              composerSpellCheck={composerSpellCheck}
              draft={promptComposerDraftsByPostId[post.id] ?? null}
              error={promptStartErrorsByPostId[post.id] ?? ""}
              highlightSources={highlightSources}
              post={post}
              projectId={projectId}
              projectRootPath={projectRootPath}
              rateLimits={rateLimits}
              thread={promptDraftThread}
              workspaceRoots={workspaceRoots}
              onDraftChange={onPromptDraftChange}
              onDraftClear={onPromptDraftClear}
              onListModels={onListModels}
              onStartPromptThread={async (postId, input, thread) => {
                await onStartPromptThread(postId, input, thread);
                setMode(null);
              }}
              onSubmitUserInputRequest={onSubmitUserInputRequest}
              onThreadAgentChange={onThreadAgentChange}
              onThreadModelChange={onThreadModelChange}
              onThreadQuestionnaireDraftChange={onThreadQuestionnaireDraftChange}
              onThreadQuestionnaireDraftClear={onThreadQuestionnaireDraftClear}
              onThreadReasoningEffortChange={onThreadReasoningEffortChange}
              onThreadSavedComposerDraftDelete={onThreadSavedComposerDraftDelete}
              onThreadSavedComposerDraftSave={onThreadSavedComposerDraftSave}
              onThreadServiceTierChange={onThreadServiceTierChange}
            />
          ) : (
            <p className="m-0 px-1 py-4 text-[0.86rem] leading-6 text-muted">Preparing prompt composer...</p>
          )}
        </div>
      )}
    </>
  ) : (
    renderedPostBody
  );

  return (
    <CollaborationTreeDropController
      activeDrag={activeDrag}
      postId={post.id}
      onDrop={onMovePost}
    >
      <article
        className={joinClasses(
          "relative py-2",
          depth > 0 && "pl-4 md:pl-5",
        )}
      >
        {depth > 0 ? (
          <div className="absolute bottom-2 left-1 top-2 w-px rounded-full bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
        ) : null}
        <CollaborationPostSurface
          author={post.author}
          authorLabel={authorLabel}
          canDrag={canDragPost}
          isActive={mode !== null}
          isClickable={isPromptPost && mode !== "edit-post" && mode !== "prompt"}
          isPromptPost={isPromptPost}
          menuAction={(
            <CollaborationPostMenuButton
              post={post}
              onDelete={() => {
                onDeletePost(post.id);
              }}
              onEdit={() => {
                setMode("edit-post");
              }}
              onOpenHistory={() => {
                onOpenRevisionHistory(post.id);
              }}
              onOpenPromptThread={() => {
                if (post.promptThreadId) {
                  onOpenPromptThread(post.promptThreadId);
                }
              }}
            />
          )}
          primaryAction={primaryAction}
          updatedAt={post.updatedAt}
          onClick={openPromptComposer}
          onPointerDown={(event) => {
            if (!canDragPost || shouldIgnorePostDragStart(event)) {
              return;
            }

            onPostPointerDragStart(event, post);
          }}
        >
          {bodyContent}
        </CollaborationPostSurface>
        {mode !== "edit-post" && mode !== "reply" ? (
          <div className="mt-1 px-3" data-collaboration-no-drag="true">
            <PostReplyButton
              onClick={() => {
                setMode("reply");
              }}
            />
          </div>
        ) : null}
        {mode === "reply" ? (
          <div className="mt-1 pl-4 md:pl-5" data-collaboration-no-drag="true">
            <CollaborationPostComposer
              composerSpellCheck={composerSpellCheck}
              harness={harness}
              highlightSources={highlightSources}
              id={`collaboration-reply:${post.id}`}
              label="Reply"
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
              onCancel={() => {
                setMode(null);
              }}
              onSubmit={(draft) => {
                onCreatePost(post.id, draft);
                setMode(null);
              }}
            />
          </div>
        ) : null}
        {childPosts.length ? (
          <div className="mt-1">
            {childPosts.map((childPost) => (
              <CollaborationPostNode
                key={childPost.id}
                activeDrag={activeDrag}
                composerSpellCheck={composerSpellCheck}
                depth={depth + 1}
                harness={harness}
                highlightSources={highlightSources}
                post={childPost}
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
          </div>
        ) : null}
      </article>
    </CollaborationTreeDropController>
  );
}
