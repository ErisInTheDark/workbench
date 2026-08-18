/*
 * Exports:
 * - default ThreadCheckpointCommitItem: render and operate a durable checkpoint commit proposal with a frozen file set. Keywords: thread, checkpoint, proposal, commit, newer changes.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  GitCheckpointProposalSchema,
} from "../../../lib/workbench/git/checkpoint-contracts";
import reportClientSchemaError from "../../../lib/workbench/report-client-schema-error";
import type {
  GitCheckpointCommitCommandIntent,
  ThreadCommandExecutionOutcome,
} from "../../../lib/workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, {
  type CheckpointCommitCardState,
} from "./ThreadCheckpointCommitCard";

async function readProposalResponse(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    try {
      const errorPayload = JSON.parse(text) as { error?: string };
      throw new Error(errorPayload.error || "Unable to load checkpoint proposal.");
    } catch (error) {
      if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
      throw new Error(text.trim() || "Unable to load checkpoint proposal.");
    }
  }
  const parsed = GitCheckpointProposalSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    reportClientSchemaError("Rejected checkpoint proposal response", parsed.error);
    throw new Error("Workbench returned an invalid checkpoint proposal response.");
  }
  return parsed.data;
}

export default function ThreadCheckpointCommitItem({
  commandOutcome,
  cwd,
  intent,
  projectFilePaths,
  projectId,
  projectRootPath,
  proposalId,
  sourceItemId,
  threadId,
  workspaceRoots,
}: {
  commandOutcome: ThreadCommandExecutionOutcome;
  cwd: string;
  intent: GitCheckpointCommitCommandIntent;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  proposalId: string | null;
  sourceItemId: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const [includeNewer, setIncludeNewer] = useState(false);
  const [title, setTitle] = useState(intent.title);
  const [description, setDescription] = useState(intent.description);
  const [committing, setCommitting] = useState(false);
  const [state, setState] = useState<CheckpointCommitCardState>({ status: "pending" });

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    if (!proposalId) return;
    setState((current) => current.status === "loaded" ? current : { status: "pending" });
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({ action: "proposalState", cwd, includeNewer, proposalId, threadId }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal,
      }));
      if (signal?.aborted) return;
      if (proposal.status !== "proposed") {
        setTitle(proposal.title);
        setDescription(proposal.description);
      }
      if (!proposal.includeNewerAvailable && includeNewer) setIncludeNewer(false);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        error: error instanceof Error ? error.message : "Unable to load checkpoint proposal.",
        retryable: true,
        status: "error",
      });
    }
  }, [cwd, includeNewer, proposalId, threadId]);

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
        setState({ error: failure, retryable: false, status: "error" });
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
  }, [commandOutcome, loadProposal, proposalId]);

  const commit = async () => {
    if (!title.trim() || committing) return;
    setCommitting(true);
    try {
      const proposal = await readProposalResponse(await fetch("/api/git-checkpoint", {
        body: JSON.stringify({
          action: "proposalCommit",
          cwd,
          description,
          includeNewer,
          proposalId,
          threadId,
          title,
        }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }));
      setTitle(proposal.title);
      setDescription(proposal.description);
      setState({ proposal, status: "loaded" });
    } catch (error) {
      setState({
        error: error instanceof Error ? error.message : "Unable to commit checkpoint proposal.",
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
      includeNewer={includeNewer}
      onCommit={() => void commit()}
      onDescriptionChange={setDescription}
      onIncludeNewerChange={setIncludeNewer}
      onRetry={() => void loadProposal()}
      onTitleChange={setTitle}
      paths={intent.paths}
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
