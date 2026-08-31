/*
 * Exports:
 * - default ThreadCheckpointCommitItem: render and operate a durable checkpoint commit proposal with a frozen file set. Keywords: thread, checkpoint, proposal, commit, newer changes.
 */
"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { WorkbenchHarness } from "../../../lib/types";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  parseGitArcFailureReceipt,
} from "../../../lib/workbench/git/git-arc-failures";
import type {
  GitCheckpointCommitCommandIntent,
  ThreadCommandExecutionOutcome,
} from "../../../lib/workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, {
  type CheckpointCommitCardState,
} from "./ThreadCheckpointCommitCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { proposalIntentOwnsMessage } from "./thread-git-arc-proposal-intents";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";

interface ThreadCheckpointCommitItemProps {
  commandOutcome: ThreadCommandExecutionOutcome;
  failureReason?: string | null;
  cwd: string | null;
  embedded?: boolean;
  harness?: WorkbenchHarness;
  hoisted?: boolean;
  intent: GitCheckpointCommitCommandIntent | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  presentation?: "compact-commit" | "compact-preview" | "full";
  proposalId: string | null;
  sourceItemId: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

function ThreadCheckpointCommitController({
  commandOutcome,
  cwd,
  embedded,
  failureReason,
  harness,
  intent,
  projectFilePaths,
  projectId,
  projectRootPath,
  presentation,
  proposalId,
  sourceItemId,
  threadId,
  workspaceRoots,
}: ThreadCheckpointCommitItemProps & { cwd: string; harness: WorkbenchHarness }) {
  const daemon = useWorkbenchDaemonClient();
  const [includeNewer, setIncludeNewer] = useState(false);
  const [title, setTitle] = useState(intent?.title ?? (presentation && presentation !== "full" ? "Commit proposal" : ""));
  const [description, setDescription] = useState(intent?.description ?? "");
  const [committing, setCommitting] = useState(false);
  const [state, setState] = useState<CheckpointCommitCardState>({ status: "pending" });
  const intentOwnsMessage = proposalIntentOwnsMessage(intent);
  const titleHydrated = useRef(intentOwnsMessage);
  const descriptionHydrated = useRef(intentOwnsMessage);

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    if (!proposalId) return;
    setState((current) => current.status === "loaded" ? current : { status: "pending" });
    try {
      const proposal = await daemon.requestGitArc(
        "git/arc/proposal/read",
        { cwd, harness, includeNewer, proposalId, threadId },
      );
      if (signal?.aborted) return;
      if (!titleHydrated.current || proposal.status !== "proposed") setTitle(proposal.title);
      if (!descriptionHydrated.current || proposal.status !== "proposed") setDescription(proposal.description);
      titleHydrated.current = true;
      descriptionHydrated.current = true;
      if (!proposal.includeNewerAvailable && includeNewer) setIncludeNewer(false);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      if (signal?.aborted) return;
      const failure = error instanceof GitArcFailureException
        ? error.failure
        : createGitArcOperationRejected("proposalState", error instanceof Error ? error.message : "Unable to load checkpoint proposal.");
      setState({
        error: error instanceof Error ? error.message : "Unable to load checkpoint proposal.",
        failure,
        retryable: true,
        status: "error",
      });
    }
  }, [cwd, daemon, harness, includeNewer, proposalId, threadId]);

  useEffect(() => {
    if (!proposalId) {
      const failure = commandOutcome === "declined"
        ? "Checkpoint proposal creation was declined."
        : commandOutcome === "failed"
          ? "Checkpoint proposal creation failed."
          : commandOutcome === "timedOut"
            ? "Checkpoint proposal creation timed out."
            : null;
      if (failure) {
        setState({
          error: failure,
          failure: parseGitArcFailureReceipt(failureReason ?? "")
            ?? createGitArcOperationRejected("proposalCreate", failureReason?.trim() || failure),
          retryable: false,
          status: "error",
        });
      } else {
        setState({ status: "pending" });
      }
      return;
    }
    const controller = new AbortController();
    void loadProposal(controller.signal);
    const refreshOnFocus = () => { void loadProposal(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [commandOutcome, failureReason, loadProposal, proposalId]);

  const commit = async () => {
    if (!proposalId || !title.trim() || committing) return;
    setCommitting(true);
    try {
      const proposal = await daemon.requestGitArc(
        "git/arc/proposal/commit",
        {
          cwd,
          description,
          harness,
          includeNewer,
          proposalId,
          threadId,
          title,
        },
      );
      setTitle(proposal.title);
      setDescription(proposal.description);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      const failure = error instanceof GitArcFailureException
        ? error.failure
        : createGitArcOperationRejected("proposalCommit", error instanceof Error ? error.message : "Unable to commit checkpoint proposal.");
      setState({
        error: error instanceof Error ? error.message : "Unable to commit checkpoint proposal.",
        failure,
        retryable: true,
        status: "error",
      });
    } finally {
      setCommitting(false);
    }
  };

  const changeDescription = (value: string) => {
    descriptionHydrated.current = true;
    setDescription(value);
  };
  const changeTitle = (value: string) => {
    titleHydrated.current = true;
    setTitle(value);
  };

  return (
    <ThreadCheckpointCommitCard
      committing={committing}
      description={description}
      embedded={embedded}
      includeNewer={includeNewer}
      onCommit={() => void commit()}
      onDescriptionChange={changeDescription}
      onIncludeNewerChange={setIncludeNewer}
      onRetry={() => void loadProposal()}
      onTitleChange={changeTitle}
      paths={intent?.paths ?? []}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      presentation={presentation}
      sourceItemId={sourceItemId}
      state={state}
      title={title}
      workspaceRoots={workspaceRoots}
    />
  );
}

export default function ThreadCheckpointCommitItem(props: ThreadCheckpointCommitItemProps) {
  const presentation = useContext(ThreadGitArcPresentationContext);
  const harness = props.harness ?? presentation?.harness ?? "codex";
  const hoistedTargetId = props.proposalId ? `thread-checkpoint-proposal-${props.proposalId}` : null;
  const resolvedIntent = props.intent ?? (props.proposalId ? presentation?.proposalIntents?.get(props.proposalId) ?? null : null);
  if (!props.hoisted && props.proposalId && hoistedTargetId && (
    presentation?.hoistedProposalIds?.has(props.proposalId) || presentation?.hoistedProposalId === props.proposalId
  )) {
    return (
      <ThreadGitArcItem
        commandIntent={{ action: "propose", intentName: null, paths: [], ref: null }}
        durationMs={null}
        outcome="completed"
        proposalRedirect={{
          onActivate: () => document.getElementById(hoistedTargetId)?.scrollIntoView({ behavior: "smooth", block: "center" }),
          proposalId: props.proposalId,
          title: resolvedIntent?.title ?? "Commit proposal",
        }}
        receipt={null}
      />
    );
  }
  if (!props.cwd) {
    return (
      <ThreadCheckpointCommitCard
        committing={false}
        description={resolvedIntent?.description ?? ""}
        embedded={props.embedded}
        includeNewer={false}
        onCommit={() => undefined}
        onDescriptionChange={() => undefined}
        onIncludeNewerChange={() => undefined}
        onRetry={() => undefined}
        onTitleChange={() => undefined}
        paths={resolvedIntent?.paths ?? []}
        presentation="compact-preview"
        projectFilePaths={props.projectFilePaths}
        projectId={props.projectId}
        projectRootPath={props.projectRootPath}
        sourceItemId={props.sourceItemId}
        state={{ status: "pending" }}
        title={resolvedIntent?.title ?? "Commit proposal"}
        workspaceRoots={props.workspaceRoots}
      />
    );
  }
  const controller = <ThreadCheckpointCommitController {...props} cwd={props.cwd} harness={harness} intent={resolvedIntent} />;
  return props.hoisted && hoistedTargetId
    ? <div className="scroll-mt-6" id={hoistedTargetId}>{controller}</div>
    : controller;
}
