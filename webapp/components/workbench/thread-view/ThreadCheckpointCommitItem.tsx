/*
 * Exports:
 * - default ThreadCheckpointCommitItem: render and operate a durable checkpoint commit proposal with a frozen file set. Keywords: thread, checkpoint, proposal, commit, newer changes.
 */
"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { WorkbenchHarness } from "../../../lib/types";
import {
  GitCheckpointProposalSchema,
} from "../../../lib/workbench/git/checkpoint-contracts";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  parseGitArcFailureEnvelope,
  parseGitArcFailureReceipt,
  type GitArcFailureAction,
} from "../../../lib/workbench/git/git-arc-failures";
import reportClientSchemaError from "../../../lib/workbench/report-client-schema-error";
import type {
  GitCheckpointCommitCommandIntent,
  ThreadCommandExecutionOutcome,
} from "../../../lib/workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, {
  type CheckpointCommitCardState,
} from "./ThreadCheckpointCommitCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

async function readProposalResponse(response: Response, action: GitArcFailureAction) {
  const text = await response.text();
  if (!response.ok) {
    try {
      const envelope = parseGitArcFailureEnvelope(text, (error) => {
        reportClientSchemaError("Rejected Git arc proposal failure response", error);
      });
      if (envelope) throw new GitArcFailureException(envelope.gitArcFailure);
      const errorPayload = JSON.parse(text) as { error?: string };
      throw new GitArcFailureException(createGitArcOperationRejected(action, errorPayload.error || "Unable to load checkpoint proposal."));
    } catch (error) {
      if (error instanceof GitArcFailureException) throw error;
      throw new GitArcFailureException(createGitArcOperationRejected(action, text.trim() || "Unable to load checkpoint proposal."));
    }
  }
  const parsed = GitCheckpointProposalSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    reportClientSchemaError("Rejected checkpoint proposal response", parsed.error);
    throw new Error("Workbench returned an invalid checkpoint proposal response.");
  }
  return parsed.data;
}

interface ThreadCheckpointCommitItemProps {
  commandOutcome: ThreadCommandExecutionOutcome;
  failureReason?: string | null;
  cwd: string;
  embedded?: boolean;
  harness?: WorkbenchHarness;
  hoisted?: boolean;
  intent: GitCheckpointCommitCommandIntent | null;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
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
  proposalId,
  sourceItemId,
  threadId,
  workspaceRoots,
}: ThreadCheckpointCommitItemProps & { harness: WorkbenchHarness }) {
  const [includeNewer, setIncludeNewer] = useState(false);
  const [title, setTitle] = useState(intent?.title ?? "");
  const [description, setDescription] = useState(intent?.description ?? "");
  const [committing, setCommitting] = useState(false);
  const [state, setState] = useState<CheckpointCommitCardState>({ status: "pending" });
  const hydratedFallbackIntent = useRef(intent !== null);

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    if (!proposalId) return;
    setState((current) => current.status === "loaded" ? current : { status: "pending" });
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({ action: "proposalState", cwd, harness, includeNewer, proposalId, threadId }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      }), "proposalState");
      if (signal?.aborted) return;
      if (!hydratedFallbackIntent.current || proposal.status !== "proposed") {
        setTitle(proposal.title);
        setDescription(proposal.description);
      }
      hydratedFallbackIntent.current = true;
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
  }, [cwd, harness, includeNewer, proposalId, threadId]);

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
    if (!title.trim() || committing) return;
    setCommitting(true);
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({
          action: "proposalCommit",
          cwd,
          description,
          harness,
          includeNewer,
          proposalId,
          threadId,
          title,
        }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }), "proposalCommit");
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

  return (
    <ThreadCheckpointCommitCard
      committing={committing}
      description={description}
      embedded={embedded}
      includeNewer={includeNewer}
      onCommit={() => void commit()}
      onDescriptionChange={setDescription}
      onIncludeNewerChange={setIncludeNewer}
      onRetry={() => void loadProposal()}
      onTitleChange={setTitle}
      paths={intent?.paths ?? []}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
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
  if (!props.hoisted && props.proposalId && (
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
  const controller = <ThreadCheckpointCommitController {...props} harness={harness} intent={resolvedIntent} />;
  return props.hoisted && hoistedTargetId
    ? <div className="scroll-mt-6" id={hoistedTargetId}>{controller}</div>
    : controller;
}
