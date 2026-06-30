/*
 * Exports:
 * - default CollaborationPostNode: render one recursive Collaboration post branch with single-surface post, collapsed, prompt, edit, and reply modes. Keywords: collaboration, post, tree, recursive, prompt, collapse.
 * - Local helpers: draft conversion, collapsed previews, action buttons, and drag-start filtering. Keywords: collaboration, composer, drag, prompt, collapse.
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
import type {
  CollaborationPostDropIntent,
  WorkbenchCollaborationPostDraft,
} from "../../../lib/workbench/collaboration/collaboration-tree-mutations";
import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import PrimaryButton from "../PrimaryButton";
import ThreadMarkdown from "../thread-view/ThreadMarkdown";
import { ReplyArrowIcon, SparkleIcon } from "../workbench-icons";
import CollaborationPostComposer from "./CollaborationPostComposer";
import CollaborationPostMenuButton from "./CollaborationPostMenuButton";
import CollaborationPostSurface from "./CollaborationPostSurface";
import CollaborationPromptComposer from "./CollaborationPromptComposer";
import CollaborationTreeDropController from "./CollaborationTreeDropController";

type CollaborationPromptComposerProps = ComponentProps<typeof CollaborationPromptComposer>;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function draftFromPost (post: WorkbenchCollaborationPost): WorkbenchThreadComposerDraft {
  return {
    attachments: post.attachments ?? [],
    text: post.body,
    updatedAt: post.updatedAt,
  };
}

function getCollapsedPostPreviewText (post: WorkbenchCollaborationPost) {
  return post.body.split(/\r?\n/).find((line) => line.trim())?.trim() || "Empty post";
}

function shouldIgnorePostDragStart (event: ReactPointerEvent<HTMLElement>) {
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

function SuggestedPromptButton ({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.78rem] font-semibold text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      data-collaboration-no-drag="true"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <SparkleIcon className="size-3.5" />
      Suggested prompt
    </button>
  );
}

function PostReplyButton ({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex relative items-center gap-1.5 pb-1 [border-bottom-right-radius:calc(var(--spacing)*3.5)] [border-bottom-left-radius:calc(var(--spacing)*3.5)] px-2 text-[0.78rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      data-collaboration-no-drag="true"
      onClick={onClick}
    >
      <ReplyArrowIcon className="size-3.5" />
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
  const [isEditingPost, setIsEditingPost] = useState(false);
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const childPosts = useMemo(() => post.childIds.map((childId) => state.posts[childId]).filter((child): child is WorkbenchCollaborationPost => Boolean(child)), [post.childIds, state.posts]);
  const authorLabel = post.author === "agent" ? "Agent" : "User";
  const canDragPost = !isEditingPost && !isPromptOpen && !isReplying;
  const promptDraftThread = promptDraftThreadsByPostId[post.id] ?? null;
  const isPromptPost = Boolean(post.prompt || post.promptThreadId);
  const hasUnmaterializedSuggestedPrompt = Boolean(post.prompt && !post.promptThreadId);
  const canToggleCollapsed = !isEditingPost && !isPromptOpen && !isReplying;

  const openPromptComposer = () => {
    if (!post.prompt || post.promptThreadId) {
      return;
    }

    onEnsurePromptDraftThread(post);

    if (!isEditingPost) {
      setIsCollapsed(false);
      setIsPromptOpen(true);
    }
  };

  const toggleCollapsed = () => {
    if (!canToggleCollapsed) {
      return;
    }

    setIsCollapsed((current) => !current);
  };

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
      ) : null}
    </>
  );

  const bodyContent = isEditingPost ? (
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
          setIsEditingPost(false);
        }}
        onSubmit={(draft) => {
          onEditPost(post.id, {
            ...draft,
            prompt: post.prompt,
          });
          setIsEditingPost(false);
        }}
      />
    </div>
  ) : isPromptOpen && post.prompt && !post.promptThreadId ? (
    <>
      {renderedPostBody}
      <div className="relative mt-2 pl-[0.9rem]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[3.25rem] left-0 top-1 w-[0.18rem] rounded-full bg-[color-mix(in_srgb,var(--text)_14%,transparent)]"
        />
        <div className="relative" data-collaboration-no-drag="true">
          <div className="min-w-0">
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
                  setIsPromptOpen(false);
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
          <div className="absolute right-0 top-0 z-10">
            <CollapsePromptButton onClick={() => { setIsPromptOpen(false); }} />
          </div>
        </div>
      </div>
    </>
  ) : (
    <>
      {renderedPostBody}
      {hasUnmaterializedSuggestedPrompt ? (
        <div className="mt-2 flex justify-end" data-collaboration-no-drag="true">
          <SuggestedPromptButton onClick={openPromptComposer} />
        </div>
      ) : null}
    </>
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
        <CollaborationPostSurface
          author={post.author}
          authorLabel={authorLabel}
          canDrag={canDragPost}
          collapsedPreviewText={getCollapsedPostPreviewText(post)}
          isActive={isEditingPost || isPromptOpen || isReplying}
          isClickable={canToggleCollapsed}
          isCollapsed={isCollapsed}
          isPromptPost={isPromptPost}
          menuAction={(
            <CollaborationPostMenuButton
              post={post}
              onDelete={() => {
                onDeletePost(post.id);
              }}
              onEdit={() => {
                setIsCollapsed(false);
                setIsEditingPost(true);
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
          updatedAt={post.updatedAt}
          onClick={toggleCollapsed}
          onPointerDown={(event) => {
            if (!canDragPost || shouldIgnorePostDragStart(event)) {
              return;
            }

            onPostPointerDragStart(event, post);
          }}
        >
          {bodyContent}
        </CollaborationPostSurface>
        {!isCollapsed ? (
          <div className="relative before:block before:absolute before:-top-5 before:bottom-0 before:[border-left:3px_solid_color-mix(in_srgb,var(--text)_4%,transparent)] before:[mask-image:linear-gradient(to_bottom,transparent_0%,black_calc(var(--spacing)_*_4),black_calc(100%_-_var(--spacing)_*_2),transparent_100%)]">
            {!isReplying ? (
              <div className="flex px-3" data-collaboration-no-drag="true">
                <PostReplyButton
                  onClick={() => {
                    setIsReplying(true);
                  }}
                />
              </div>
            ) : null}
            {isReplying ? (
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
                    setIsReplying(false);
                  }}
                  onSubmit={(draft) => {
                    onCreatePost(post.id, draft);
                    setIsReplying(false);
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
          </div>
        ) : null}
      </article>
    </CollaborationTreeDropController>
  );
}
