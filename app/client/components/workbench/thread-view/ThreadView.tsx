/*
 * Exports:
 * - default ThreadView: hold a launched draft until canonical content is renderable, gate ordinary thread loads, and provide the thread animation style.
 */
"use client";

import { useCallback, useState, type ComponentProps } from "react";
import type { ThreadPayload } from "workbench-shared/types";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { useThread } from "../use-thread";
import { useTranscript } from "../use-transcript";
import { resolveThreadViewHandoff, type ThreadViewDisplay } from "./thread-view-handoff";
import ThreadViewContent from "./ThreadViewContent";
import ThreadAnimationStyleContext from "./ThreadAnimationStyleContext";
import { THREAD_ANIMATION_STYLES } from "../../../workbench/thread/thread-animation-styles";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";
import { useSettings } from "../use-settings";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";

export default function ThreadView({ thread: fallbackThread, routeOwned = false, routeError = "", settingsLocation = null,
  fontSizeRem, ...props }: Omit<ComponentProps<typeof ThreadViewContent>,
    "rootTarget" | "composerSpellCheck" | "threadCodeBlockWrap" | "threadCodeDetails" | "onThreadCodeBlockWrapChange" | "fontSizeRem">
  & { thread?: ThreadPayload | null; routeOwned?: boolean; routeError?: string;
    settingsLocation?: ProjectLocationReference | null; fontSizeRem?: number }) {
  const requested = props.threadTarget ?? (fallbackThread?.isDraft
    ? { kind: "draft" as const, draftId: fallbackThread.id }
    : fallbackThread ? { kind: "provider" as const, harness: fallbackThread.harness, threadId: fallbackThread.id } : null);
  const target = requested?.kind === "new" && fallbackThread?.isDraft
    ? { kind: "draft" as const, draftId: fallbackThread.id }
    : requested?.kind === "subagent"
    ? { kind: "provider" as const, threadId: requested.parentThreadId }
    : requested;
  const rootId = target?.kind === "draft" ? target.draftId : target && "threadId" in target ? target.threadId : "";
  const [selection, setSelection] = useState({ rootId, id: props.selectedThreadId ?? rootId });
  const selectedId = props.selectedThreadId ?? (selection.rootId === rootId ? selection.id : rootId);
  const requestedDisplay: ThreadViewDisplay | null = target && target.kind !== "new"
    ? { projectId: props.projectId, viewInstanceKey: props.viewInstanceKey ?? rootId, target } : null;
  const [previousDisplay, setPreviousDisplay] = useState(requestedDisplay);
  const interest = routeOwned ? "route" : "view";
  const thread = useThread(props.projectId, target, interest);
  const child = thread.subagents.find(candidate => candidate.threadId === selectedId);
  const active = useThread(props.projectId, selectedId && selectedId !== rootId
    ? thread.status === "ready" ? { kind: "subagent", parentThreadId: ThreadReferenceSchema.parse(rootId), threadId: ThreadReferenceSchema.parse(selectedId), harness: child?.harness } : null
    : target, selectedId !== rootId ? "view" : interest);
  const activeTurns = useTranscript.turns(active.store);
  const heldDraft = useThread(previousDisplay?.projectId ?? props.projectId,
    previousDisplay?.target.kind === "draft" ? previousDisplay.target : null);
  const heldTurns = useTranscript.turns(heldDraft.store);
  const display = requestedDisplay ? resolveThreadViewHandoff(previousDisplay, requestedDisplay, {
    hasDraftInput: heldTurns.turns.length > 0,
    headReady: thread.status === "ready" && Boolean(thread.head) && active.status === "ready" && Boolean(active.head),
    turns: activeTurns,
  }) : null;
  if (display !== previousDisplay) setPreviousDisplay(display);
  const holdingDraft = display?.target.kind === "draft" && target?.kind === "provider";
  const settings = useSettings.forThread(display?.target ?? target, settingsLocation);
  const [settingsFailure, setSettingsFailure] = useState<{ owner: string | null; message: string } | null>(null);
  const reportError = props.onQuestionnaireError;
  const setCodeWrap = useCallback((value: boolean) => {
    setSettingsFailure(null);
    void settings.set("threadCodeBlockWrap", value).catch((error: Error) => {
      if (reportError) reportError(error.message);
      else setSettingsFailure({ owner: settings.projectId, message: error.message });
    });
  }, [settings, reportError]);
  const onSelectedThreadChange = props.onSelectedThreadChange;
  // A stable handler keeps the memoized content from re-rendering on every summary push this gate reads.
  const selectThread = useCallback((id: string) => {
    setSelection({ rootId, id });
    onSelectedThreadChange?.(id);
  }, [onSelectedThreadChange, rootId]);
  const transcriptError = activeTurns.transcript.status === "failed" ? activeTurns.transcript.message
    : activeTurns.transcript.status === "unavailable" ? "The transcript source is unavailable." : "";
  const error = (thread.error ?? active.error ?? (!thread.head ? routeError : "")) || (holdingDraft ? transcriptError : "");
  if (error && !holdingDraft) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 py-8">
        <div role="alert" className="flex min-w-[16rem] max-w-full flex-col gap-2 rounded-[1.4rem] border border-danger bg-danger/10 px-5 py-4 text-left">
          <p className="m-0 text-[1rem] font-semibold leading-tight text-text">Unable to open thread</p>
          <p className="m-0 break-words text-sm text-text">{error}</p>
          {props.threadOwnerContent ? <p className="m-0 text-sm">{props.threadOwnerContent}</p> : null}
        </div>
      </div>
    );
  }
  if (!display || !props.projectId || (!holdingDraft && (thread.status !== "ready" || !thread.head || active.status !== "ready" || !active.head))) return <WorkbenchLoadingSpinner label="Loading thread" />;
  return <>
    {settingsFailure?.owner === settings.projectId && settingsFailure
      ? <p role="alert" className="px-6 py-3 text-danger">{settingsFailure.message}</p> : null}
    {holdingDraft && error ? <p role="alert" className="px-6 py-3 text-danger">{error}</p> : null}
    <ThreadAnimationStyleContext value={THREAD_ANIMATION_STYLES[settings.get("threadAnimationStyle")]}>
    <ThreadViewContent {...props}
      composerSpellCheck={settings.get("composerSpellCheck")}
      threadCodeBlockWrap={settings.get("threadCodeBlockWrap")}
      threadCodeDetails={settings.get("threadCodeDetails")}
      onThreadCodeBlockWrapChange={setCodeWrap}
      fontSizeRem={fontSizeRem ?? settings.get("editorFontSize")}
      projectId={display.projectId}
      rootTarget={display.target}
      threadTarget={holdingDraft ? display.target : props.threadTarget}
      selectedThreadId={holdingDraft && display.target.kind === "draft" ? display.target.draftId : selectedId}
      onSelectedThreadChange={selectThread}
    />
    </ThreadAnimationStyleContext>
  </>;
}
