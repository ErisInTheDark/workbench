/*
 * Exports:
 * - default ThreadSubagentPromoteItem: a subagent promotion as a card: "Promoted", the children and a held Take back per
 *   child still in the sidebar on the line, opening into each child's thread row.
 */
"use client";

import { useContext, useState } from "react";

import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { parsePromotedSubagents, type PromotedSubagent } from "workbench-shared/workbench/subagent/subagent-promotion";
import PrimaryButton from "../../ui/PrimaryButton";
import { useThread } from "../use-thread";
import WorkbenchThreadReferenceList from "../WorkbenchThreadReferenceList";
import { BotIcon, Undo2Icon } from "../workbench-icons";
import ThreadAgentNameList, { type ThreadAgentNameListEntry } from "./ThreadAgentNameList";
import ThreadCard from "./ThreadCard";
import ThreadItemActionsContext from "./ThreadItemActionsContext";
import { stepLabel, stepLabels, type StepState } from "./thread-step";

const LABELS = stepLabels("Promoting", "Promoted", "Failed to promote");
const TAKE_BACK_HOLD_MS = 1_000;

type Promoted = Extract<PromotedSubagent, { failure: null }>;

function PromotedChild({ child }: { child: Promoted }) {
  const threadId = WorkbenchThreadIdSchema.safeParse(child.threadId).data ?? null;
  const located = useThread.summary(threadId);
  const row = located?.summary.row ?? null;
  return located && row ? (
    <WorkbenchThreadReferenceList references={[{
      entry: row, identity: row.identity, logicalProjectId: located.logicalProjectId, projectId: located.location.projectId, title: row.title,
    }]} />
  ) : <span className="px-2 text-fg/muted">{child.name} is a sidebar thread</span>;
}

/** Held, since it moves a running thread; absent where transcript items are read-only or the child is a subagent again. */
function TakeBack({ child, itemId, named }: { child: Promoted; itemId: string; named: boolean }) {
  const actions = useContext(ThreadItemActionsContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returned = useThread.summary(WorkbenchThreadIdSchema.safeParse(child.threadId).data ?? null)?.summary.row.entryKind === "subagent";
  if (!actions || returned) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {error ? <span className="min-w-0 truncate text-danger" role="alert" title={error}>{error}</span> : null}
      <PrimaryButton
        disabled={busy}
        holdToConfirmMs={TAKE_BACK_HOLD_MS}
        onClick={(event) => {
          event.stopPropagation();
          setBusy(true);
          setError("");
          void actions.takeBackPromotedSubagent(itemId, child.threadId)
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Unable to take back the subagent."))
            .finally(() => setBusy(false));
        }}
        pendingHalo={busy}
        shape="compact"
        title={`Hold to make ${child.name} this thread's subagent again`}
      >
        <Undo2Icon className="mr-1.5" size={14} />{named ? `Take back ${child.name}` : "Take back"}
      </PrimaryButton>
    </span>
  );
}

export default function ThreadSubagentPromoteItem({ durationMs, entries, itemId, outcome, output }: {
  durationMs: number | null;
  entries: readonly ThreadAgentNameListEntry[];
  itemId: string;
  outcome: StepState;
  output: string;
}) {
  const children = parsePromotedSubagents(output);
  const promoted = children.filter((child): child is Promoted => child.failure === null);
  const failed = children.filter(child => child.failure !== null);
  return (
    <ThreadCard
      icon={<BotIcon size={16} />}
      label={stepLabel(LABELS, outcome)}
      meta={promoted.map(child => <TakeBack child={child} itemId={itemId} key={child.threadId} named={promoted.length > 1} />)}
      progress={{ durationMs, state: outcome }}
      subject={<ThreadAgentNameList entries={entries} />}
    >
      {children.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 pb-2">
          {promoted.map(child => <li key={child.threadId}><PromotedChild child={child} /></li>)}
          {failed.map(child => <li className="px-2 text-danger" key={child.name}>{child.name} was not promoted: {child.failure}</li>)}
        </ul>
      ) : output ? <p className="m-0 pb-2 whitespace-pre-wrap text-fg/muted">{output}</p> : null}
    </ThreadCard>
  );
}
