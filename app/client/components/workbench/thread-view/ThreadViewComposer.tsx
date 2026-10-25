/*
 * Exports:
 * - default ThreadViewComposer: the shown thread's composer: profile slot and selection, send/stop/compact/model actions, approval mode, rate limits and context status; a compact-first hold scrolls the compact control into view.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { WorkbenchComposerInputDraft, WorkbenchSendThreadMessageOptions } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import resolveThreadComposerProfileSlot from "../../../workbench/thread/thread-composer-profile-slot";
import { ThreadMessageNotSentError } from "../../../workbench/thread/thread-message-submission";
import useComposer from "../use-composer";
import { useThread } from "../use-thread";
import { useThreads } from "../use-threads";
import { useTranscript } from "../use-transcript";
import WorkbenchApprovalModeMenu, { ApprovalReviewerSetupNotice, useApprovalReviewerReady } from "../WorkbenchApprovalModeMenu";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import type DraftSessionController from "./DraftSessionController";
import ThreadComposer from "./ThreadComposer";
import ThreadContextStatus from "./ThreadContextStatus";
import ThreadRateLimits from "./ThreadRateLimits";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import type { ThreadReferenceSelection } from "./use-thread-reference-selection";
import { readActiveTranscript } from "./ThreadViewTranscript";

type ThreadTarget = WorkbenchThreadRouteTarget;
const EMPTY_TURNS: readonly Turn[] = [];
type HighlightSources = Parameters<typeof ThreadComposer>[0]["highlightSources"];

export default function ThreadViewComposer ({
  approvalModeSettings,
  autoFocusOnEntry,
  bottomBefore,
  bottomPaddingClassName,
  composerSpellCheck,
  draftLeadingContent,
  draftTargetControl,
  header,
  highlightSources,
  onDraftSessionChange,
  onSubmitRejected,
  onThreadSettled,
  projectId,
  referenceSelection,
  rootTarget,
  routeTarget,
  target,
  threadOwnerContent,
  viewInstanceKey,
}: {
  /** Daemon projects replace the folder picker with an approval mode menu on drafts and threads. */
  approvalModeSettings: { onOpenSettings: () => void } | null;
  autoFocusOnEntry: boolean;
  /** Thread chrome above the bottom status row (status area, error card, agent tabs); never shown on a draft. */
  bottomBefore: ReactNode;
  bottomPaddingClassName: string;
  composerSpellCheck: boolean;
  draftLeadingContent: ReactNode;
  draftTargetControl: ReactNode;
  header: ReactNode;
  highlightSources: HighlightSources;
  onDraftSessionChange: (session: DraftSessionController<WorkbenchComposerInputDraft> | null) => void;
  onSubmitRejected: (error: unknown) => void;
  onThreadSettled?: (target: ThreadTarget, ownerProjectId: string) => void;
  projectId: string;
  referenceSelection: ThreadReferenceSelection;
  rootTarget: Exclude<ThreadTarget, { kind: "new" }>;
  /** The route's own thread target; a draft route's composer writes through it. */
  routeTarget: ThreadTarget | null;
  /** The shown thread: the root, or the selected subagent. */
  target: ThreadTarget;
  threadOwnerContent: ReactNode;
  viewInstanceKey: string;
}) {
  const rootThread = useThread(projectId, rootTarget);
  const rootThreadId = rootThread.head?.id ?? "";
  const active = useThread(projectId, target, "view");
  const activeThread = active.head;
  const activeSidebarEntry = active.entry;
  const turns = useTranscript.turns(active.store);
  const threads = useThreads(undefined, rootThreadId);
  const { controller: composerProfileController, snapshot: composerProfileSnapshot } = useWorkbenchComposerProfiles();
  const [isCompactSendHolding, setIsCompactSendHolding] = useState(false);
  const { revealEnd } = useThreadScrollViewportContext();
  // The compact control docks at the thread's end; bring it into view so the hold's progress is visible.
  const handleCompactSendHoldChange = useCallback((holding: boolean) => {
    setIsCompactSendHolding(holding);
    if (holding) revealEnd();
  }, [revealEnd]);
  const rateLimits = active.rateLimits;
  const activeThreadSnoozed = activeSidebarEntry?.entryKind === "thread" && activeSidebarEntry.metadata.snoozed;
  const { projection } = readActiveTranscript(activeThread, turns.transcript);
  const loadedTurns = activeThread?.isDraft || projection ? turns.turns : EMPTY_TURNS;
  const isDraftThreadView = Boolean(activeThread?.isDraft);
  const isLaunchingDraft = isDraftThreadView && loadedTurns.length > 0;
  const showDraftComposer = isDraftThreadView && !isLaunchingDraft;

  // A draft route whose saved draft is gone composes as new again, so its next words recreate it.
  const routeDraftSaved = Boolean(useComposer(projectId, activeThread?.id ?? "", routeTarget ?? null).getDraft());
  const composerTarget = useMemo(() => activeThread?.isDraft && !routeDraftSaved && routeTarget?.kind === "draft"
    ? { kind: "new" as const } : routeTarget, [activeThread?.isDraft, routeDraftSaved, routeTarget]);
  const activeProfileSlot = useMemo(() => activeThread
    ? resolveThreadComposerProfileSlot(ProjectIdSchema.parse(projectId), composerTarget, activeThread)
    : null, [activeThread?.harness, activeThread?.id, projectId, composerTarget]);
  const resolvedActiveThread = activeThread && activeProfileSlot
    ? composerProfileController.resolveThread(activeProfileSlot, activeThread)
    : activeThread;
  void composerProfileSnapshot;
  useEffect(() => {
    if (activeProfileSlot) void composerProfileController.loadSelection(activeProfileSlot);
  }, [activeProfileSlot, composerProfileController]);
  const projectedProfile = activeSidebarEntry && "profile" in activeSidebarEntry ? activeSidebarEntry.profile : undefined;
  useEffect(() => {
    if (activeProfileSlot && projectedProfile !== undefined) composerProfileController.observeSelection(activeProfileSlot, projectedProfile);
  }, [activeProfileSlot, composerProfileController, projectedProfile]);

  const onSendMessage = useComposer.send(composerProfileController);
  const handleSendMessage = useCallback(async (
    _threadId: string,
    input: UserInput[],
    options?: Pick<WorkbenchSendThreadMessageOptions, "activatedSkillPaths" | "skipAutoCompact" | "onThreadLaunched" | "stayInCreate">,
  ) => {
    if (!resolvedActiveThread || !activeProfileSlot) {
      throw new ThreadMessageNotSentError();
    }
    const draftDocument = active.draftDocument;
    if (draftDocument) {
      await onSendMessage(composerProfileController.resolveThread(activeProfileSlot, draftDocument), input, {
        ...options,
        composerProfileSlot: activeProfileSlot,
        selectThread: draftDocument.id === rootThreadId,
      });
      return;
    }
    // The daemon starts turns with the persisted profile selection, so a pending selection lands first.
    if (!isThreadStatusActive(resolvedActiveThread.status)) await composerProfileController.waitForSelection(activeProfileSlot);
    await active.actions.send(input, options);
  }, [active.actions, active.draftDocument, activeProfileSlot, composerProfileController, onSendMessage, resolvedActiveThread, rootThreadId]);

  const handleStopThread = useCallback(async () => {
    await active.actions.stop();
  }, [active.actions]);

  const handleCompactThread = useCallback(async () => {
    await active.actions.compact();
  }, [active.actions]);

  const actionsFor = useCallback((threadId: string) => (threadId === rootThreadId ? rootThread : active).actions,
    [active, rootThread, rootThreadId]);
  const handleThreadModelChange = useCallback((threadId: string, model: string) => {
    actionsFor(threadId).changeModel(model);
  }, [actionsFor]);
  const handleThreadAgentChange = useCallback((threadId: string, agentPath: string | null) => {
    actionsFor(threadId).changeAgent(agentPath);
  }, [actionsFor]);
  const handleThreadReasoningEffortChange = useCallback((threadId: string, effort: string | null) => {
    actionsFor(threadId).changeReasoningEffort(effort);
  }, [actionsFor]);
  const handleThreadServiceTierChange = useCallback((threadId: string, serviceTier: string | null) => {
    actionsFor(threadId).changeServiceTier(serviceTier);
  }, [actionsFor]);

  const handleThreadSettingsChange = useComposer.settings();
  // A draft's provider comes from its selection: move the draft document harness to match so
  // dispatch and the account rate-limit row agree. The target identity does not move.
  useEffect(() => {
    if (!activeThread?.isDraft || !activeProfileSlot) return;
    if (activeProfileSlot.kind !== "draft" && activeProfileSlot.kind !== "new-thread") return;
    const resolvedHarness = resolvedActiveThread?.harness;
    if (!resolvedHarness || resolvedHarness === activeThread.harness) return;
    const settings = composerProfileController.resolveSettings(activeProfileSlot);
    if (settings) handleThreadSettingsChange(activeThread.id, settings);
  }, [activeProfileSlot, activeThread?.harness, activeThread?.id, activeThread?.isDraft, composerProfileController, handleThreadSettingsChange, resolvedActiveThread?.harness]);

  const approvalMode = approvalModeSettings && activeProfileSlot ? composerProfileController.getApprovalMode(activeProfileSlot) : null;
  const approvalReviewer = useApprovalReviewerReady(approvalMode !== null);
  if (!activeThread) return null;
  const approvalModeControl = approvalMode && activeProfileSlot ? (
    <WorkbenchApprovalModeMenu
      mode={approvalMode}
      onOpen={approvalReviewer.refresh}
      onSelect={mode => {
        const harness = resolvedActiveThread?.harness ?? activeThread.harness;
        void composerProfileController.setApprovalMode(activeProfileSlot, mode, {
          harness, loadModels: () => threads.listModels(harness),
        });
      }}
    />
  ) : null;
  const approvalNotice = approvalMode === "auto" && approvalReviewer.ready === false && approvalModeSettings
    ? <ApprovalReviewerSetupNotice onOpenSettings={approvalModeSettings.onOpenSettings} /> : null;
  const harness = resolvedActiveThread?.harness ?? activeThread.harness;
  return (
    <ThreadComposer
      autoFocusOnEntry={autoFocusOnEntry}
      onDraftSessionChange={onDraftSessionChange}
      targetControl={approvalModeControl ?? (showDraftComposer ? draftTargetControl : null)}
      controlNotice={approvalNotice}
      header={header}
      key={target.kind === "subagent" ? activeThread.id : viewInstanceKey}
      composerSpellCheck={composerSpellCheck}
      onListModels={threads.listModels}
      subscribeModelUpdates={threads.subscribeModelUpdates}
      highlightSources={highlightSources}
      onSubmitRejected={onSubmitRejected}
      onCompactSendHoldChange={handleCompactSendHoldChange}
      onSendMessage={handleSendMessage}
      onStopThread={handleStopThread}
      onThreadSettled={onThreadSettled}
      onThreadAgentChange={handleThreadAgentChange}
      onThreadReasoningEffortChange={handleThreadReasoningEffortChange}
      onThreadServiceTierChange={handleThreadServiceTierChange}
      onThreadSettingsChange={handleThreadSettingsChange}
      onThreadModelChange={handleThreadModelChange}
      projectId={projectId}
      profileSlot={activeProfileSlot!}
      rateLimits={rateLimits}
      stickyMode={!showDraftComposer}
      bottomUi={!showDraftComposer ? {
        before: bottomBefore,
        after: (
          <ThreadRateLimits
            harness={harness}
            leadingContent={threadOwnerContent}
            rateLimits={rateLimits}
            trailingContent={(
              <ThreadContextStatus
                launching={isLaunchingDraft}
                lifecycle={activeSidebarEntry?.lifecycle}
                onCompactThread={handleCompactThread}
                sendHolding={isCompactSendHolding}
                snoozed={activeThreadSnoozed}
                thread={activeThread}
              />
            )}
          />
        ),
        paddingClassName: bottomPaddingClassName,
      } : undefined}
      thread={resolvedActiveThread!}
      turns={loadedTurns}
      threadTarget={activeThread.isDraft ? composerTarget : target}
      selectedReferences={referenceSelection.selected}
      onReferenceDeselect={reference => referenceSelection.deselect([reference])}
      onReferencesSent={referenceSelection.deselect}
    >
      {showDraftComposer ? (
        <ThreadRateLimits
          harness={harness}
          leadingContent={draftLeadingContent}
          rateLimits={rateLimits}
          trailingContent={<ThreadContextStatus lifecycle={activeSidebarEntry?.lifecycle} onCompactThread={handleCompactThread} sendHolding={isCompactSendHolding} snoozed={activeThreadSnoozed} thread={activeThread} />}
        />
      ) : null}
    </ThreadComposer>
  );
}
