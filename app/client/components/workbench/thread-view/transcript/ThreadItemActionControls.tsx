/*
 * Exports:
 * - UndeliveredSteerActions: resend or dismiss every undelivered stored steer of one bubble, in order.
 * - ThreadShellStartNowAction: start a wb shell call waiting in the expensive queue now, without taking a slot.
 * - ThreadShellStopAction: stop a running wb shell call; the transcript then shows the agent's stopped result.
 * Keep runtime exports component-only for React Refresh.
 */
"use client";

import { useContext, useState } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { PlayIcon, RefreshCwIcon, StopIcon, XIcon } from "../../workbench-icons";
import { threadBubbleControlClassName } from "../ThreadBubbleCopyButton";
import ThreadItemActionsContext from "../ThreadItemActionsContext";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

/** Runs one item action at a time, keeping its bounded failure for the hover row's alert. */
function useThreadItemActionRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await action();
      } catch (failure) {
        setError((failure instanceof Error ? failure.message : String(failure)).slice(0, 400));
      } finally {
        setBusy(false);
      }
    })();
  };
  return { busy, error, run };
}

function ThreadItemActionError({ error }: { error: string | null }) {
  return error ? (
    <span
      className="max-w-[18rem] truncate rounded-full bg-[color-mix(in_srgb,var(--text)_4%,var(--bg))] px-2 py-1 text-[0.72em] leading-tight text-danger"
      role="alert"
      title={error}
    >
      {error}
    </span>
  ) : null;
}

/** Stored steers the daemon reports undelivered; optimistic browser-only input has nothing to resend or dismiss. */
function storedUndeliveredSteerIds(items: readonly UserMessageItem[]) {
  return items.flatMap((item) => {
    const input = getWorkbenchInputState(item);
    return input?.kind === "steer" && (input.status === "failed" || input.status === "interrupted") ? [item.id] : [];
  });
}

export function UndeliveredSteerActions({ items }: { items: readonly UserMessageItem[] }) {
  const actions = useContext(ThreadItemActionsContext);
  const { busy, error, run } = useThreadItemActionRun();
  const itemIds = storedUndeliveredSteerIds(items);
  if (!actions || !itemIds.length) return null;
  const runAll = (action: (itemId: string) => Promise<void>) => run(async () => {
    for (const itemId of itemIds) await action(itemId);
  });
  const label = itemIds.length > 1 ? "steers" : "steer";
  return (
    <>
      <button
        type="button"
        aria-label={`Resend ${label}`}
        className={`${threadBubbleControlClassName} disabled:opacity-50`}
        disabled={busy}
        onClick={() => runAll(actions.resendSteer)}
        title={`Resend ${label}`}
      >
        <RefreshCwIcon size={16} />
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${label}`}
        className={`${threadBubbleControlClassName} disabled:opacity-50`}
        disabled={busy}
        onClick={() => runAll(actions.dismissSteer)}
        title={`Dismiss ${label}`}
      >
        <XIcon size={16} />
      </button>
      <ThreadItemActionError error={error} />
    </>
  );
}

export function ThreadShellStartNowAction({ itemId }: { itemId: string }) {
  const actions = useContext(ThreadItemActionsContext);
  const { busy, error, run } = useThreadItemActionRun();
  if (!actions) return null;
  const label = "Start now, skipping the expensive queue";
  return (
    <>
      <button
        type="button"
        aria-label={label}
        className={`${threadBubbleControlClassName} disabled:opacity-50`}
        disabled={busy}
        onClick={() => run(() => actions.startShellNow(itemId))}
        title={label}
      >
        <PlayIcon size={14} />
      </button>
      <ThreadItemActionError error={error} />
    </>
  );
}

export function ThreadShellStopAction({ itemId }: { itemId: string }) {
  const actions = useContext(ThreadItemActionsContext);
  const { busy, error, run } = useThreadItemActionRun();
  if (!actions) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Stop command"
        className={`${threadBubbleControlClassName} hover:text-danger focus-visible:text-danger disabled:opacity-50`}
        disabled={busy}
        onClick={() => run(() => actions.stopShell(itemId))}
        title="Stop command"
      >
        <StopIcon size={14} />
      </button>
      <ThreadItemActionError error={error} />
    </>
  );
}
