/*
 * Exports:
 * - ThreadCheckpointCommitControllerProps: identify one proposal controller and its presentation inputs.
 * - default ThreadCheckpointCommitController: demand near-visible proposal state and own edit and commit actions.
 */
"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
} from "workbench-shared/workbench/git/git-arc-failures";
import type {
  GitCheckpointCommitCommandIntent,
  ThreadCommandExecutionOutcome,
} from "../../../workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, {
  type CheckpointCommitCardState,
} from "./ThreadCheckpointCommitCard";
import ThreadGitArcItem from "./ThreadGitArcItem";
import { proposalIntentOwnsMessage } from "./thread-git-arc-presentation";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import { useThreadGitArcProposalObservation } from "./ThreadGitArcObservationContext";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";

export interface ThreadCheckpointCommitControllerProps {
  commandOutcome: ThreadCommandExecutionOutcome;
  failureReason?: string | null;
  cwd: string | null;
  embedded?: boolean;
  harness?: WorkbenchHarness;
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
  cwd,
  embedded,
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
  isProposalObserved,
  observeProposal,
  proposalObservation,
}: ThreadCheckpointCommitControllerProps & {
  cwd: string;
  harness: WorkbenchHarness;
  isProposalObserved: boolean;
  observeProposal: ((proposalId: string) => () => void) | null;
  proposalObservation: ThreadGitArcProposalObservation | null;
}) {
  const daemon = useWorkbenchDaemonClient();
  const [includeNewer, setIncludeNewer] = useState(false);
  const [includeUnclaimed, setIncludeUnclaimed] = useState(false);
  // Keep the inspected content with the choice so refresh cannot silently approve changed files.
  const [unclaimedSelection, setUnclaimedSelection] = useState<{
    proposalId: string;
    tree: string;
    changes: GitCheckpointProposal["changes"];
  } | null>(null);
  const initialMode = intent?.amend ? "amend" : "commit";
  const [commitMode, setCommitMode] = useState<"amend" | "commit">(initialMode);
  const [amendTitle, setAmendTitle] = useState(intent?.title ?? "");
  const [amendDescription, setAmendDescription] = useState(intent?.description ?? "");
  const [commitTitle, setCommitTitle] = useState(
    (intent?.amend ? intent.freshTitle : intent?.title)
      ?? "",
  );
  const [commitDescription, setCommitDescription] = useState(
    (intent?.amend ? intent.freshDescription : intent?.description) ?? "",
  );
  const [committing, setCommitting] = useState(false);
  const [observationTarget, setObservationTarget] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<CheckpointCommitCardState>(() => proposalObservation
    ? proposalObservation.status === "loaded"
      ? { proposal: proposalObservation.proposal, status: "loaded" }
      : proposalObservation.status === "failed"
        ? { error: proposalObservation.error, failure: proposalObservation.failure, retryable: true, status: "error" }
        : { status: "pending" }
    : { status: proposalId ? "pending" : "idle" });
  const intentOwnsMessage = proposalIntentOwnsMessage(intent);
  const amendTitleHydrated = useRef(Boolean(intent?.amend && intentOwnsMessage));
  const amendDescriptionHydrated = useRef(Boolean(intent?.amend && intentOwnsMessage));
  const commitTitleHydrated = useRef(Boolean(intent?.amend ? intent.freshTitle?.trim() : intentOwnsMessage));
  const commitDescriptionHydrated = useRef(Boolean(intent?.amend ? intent.freshTitle?.trim() : intentOwnsMessage));
  const title = commitMode === "amend" ? amendTitle : commitTitle;
  const description = commitMode === "amend" ? amendDescription : commitDescription;
  const freshCommitAvailable = Boolean(intent?.amend && intent.freshTitle?.trim());

  useEffect(() => {
    if (!proposalId || !observeProposal || !observationTarget) return;
    let release: (() => void) | null = null;
    const reconcile = (visible: boolean) => {
      if (visible && !release) release = observeProposal(proposalId);
      if (!visible && release) {
        release();
        release = null;
      }
    };
    if (typeof IntersectionObserver === "undefined") {
      reconcile(true);
      return () => release?.();
    }
    const observer = new IntersectionObserver(
      entries => reconcile(entries.some(entry => entry.isIntersecting)),
      { rootMargin: "160px 0px", threshold: 0 },
    );
    observer.observe(observationTarget);
    return () => {
      observer.disconnect();
      release?.();
    };
  }, [observationTarget, observeProposal, proposalId]);

  useEffect(() => {
    if (!intent) return;
    if (intent.amend) {
      if (!amendTitleHydrated.current && intent.title.trim()) {
        amendTitleHydrated.current = true;
        setAmendTitle(intent.title);
      }
      if (!amendDescriptionHydrated.current && intent.title.trim()) {
        amendDescriptionHydrated.current = true;
        setAmendDescription(intent.description);
      }
      if (!commitTitleHydrated.current && intent.freshTitle?.trim()) {
        commitTitleHydrated.current = true;
        setCommitTitle(intent.freshTitle);
      }
      if (!commitDescriptionHydrated.current && intent.freshTitle?.trim()) {
        commitDescriptionHydrated.current = true;
        setCommitDescription(intent.freshDescription ?? "");
      }
      return;
    }
    if (!commitTitleHydrated.current && intent.title.trim()) {
      commitTitleHydrated.current = true;
      setCommitTitle(intent.title);
    }
    if (!commitDescriptionHydrated.current && intent.title.trim()) {
      commitDescriptionHydrated.current = true;
      setCommitDescription(intent.description);
    }
  }, [intent]);

  const acceptProposal = useCallback((proposal: GitCheckpointProposal) => {
    setUnclaimedSelection(current => {
      if (!current) return current;
      const dirt = proposal.unclaimedDirt;
      if (current.proposalId !== proposal.proposalId || proposal.status !== "proposed" || !dirt) return null;
      const changes = current.changes.filter(change =>
        dirt.changes.some(next => areDeeplyEqual(change, next)));
      return changes.length ? { proposalId: proposal.proposalId, tree: dirt.tree, changes } : null;
    });
    if (proposal.mode === "amend") {
      if (!amendTitleHydrated.current || proposal.status !== "proposed") setAmendTitle(proposal.title);
      if (!amendDescriptionHydrated.current || proposal.status !== "proposed") setAmendDescription(proposal.description);
      amendTitleHydrated.current = true;
      amendDescriptionHydrated.current = true;
    } else {
      if (!commitTitleHydrated.current || proposal.status !== "proposed") setCommitTitle(proposal.title);
      if (!commitDescriptionHydrated.current || proposal.status !== "proposed") setCommitDescription(proposal.description);
      commitTitleHydrated.current = true;
      commitDescriptionHydrated.current = true;
    }
    if (proposal.status !== "proposed") setCommitMode(proposal.mode);
    if (!proposal.includeNewerAvailable && includeNewer) setIncludeNewer(false);
    setState({ proposal, status: "loaded" });
  }, [includeNewer]);

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    if (!proposalId) return;
    setState((current) => current.status === "loaded" ? current : { status: "pending" });
    try {
      const proposal = await daemon.requestGitArc(
        "git/arc/proposal/read",
        { cwd, harness, includeNewer, includeUnclaimed, proposalId, threadId },
      );
      if (signal?.aborted) return;
      acceptProposal(proposal);
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
  }, [acceptProposal, cwd, daemon, harness, includeNewer, includeUnclaimed, proposalId, threadId]);

  useEffect(() => {
    if (!isProposalObserved || includeNewer || includeUnclaimed) return;
    if (!proposalId) {
      setState({ status: "idle" });
      return;
    }
    if (!proposalObservation || proposalObservation.status === "loading") {
      setState({ status: "pending" });
      return;
    }
    if (proposalObservation.status === "failed") {
      setState({
        error: proposalObservation.error,
        failure: proposalObservation.failure,
        retryable: true,
        status: "error",
      });
      return;
    }
    acceptProposal(proposalObservation.proposal);
  }, [acceptProposal, includeNewer, includeUnclaimed, isProposalObserved, proposalId, proposalObservation]);

  useEffect(() => {
    if (isProposalObserved && !includeNewer && !includeUnclaimed) return;
    if (!proposalId) {
      setState({ status: "idle" });
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
  }, [includeNewer, includeUnclaimed, isProposalObserved, loadProposal, proposalId]);

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
          ...(unclaimedSelection?.proposalId === proposalId && unclaimedSelection.changes.length ? {
            unclaimedSelection: {
              paths: unclaimedSelection.changes.map(change => change.path),
              tree: unclaimedSelection.tree,
            },
          } : {}),
          ...(state.status === "loaded" && state.proposal.mode === "amend" && commitMode === "commit"
            ? { mode: "commit" as const }
            : {}),
          proposalId,
          threadId,
          title,
        },
      );
      setCommitMode(proposal.mode);
      if (proposal.mode === "amend") {
        setAmendTitle(proposal.title);
        setAmendDescription(proposal.description);
      } else {
        setCommitTitle(proposal.title);
        setCommitDescription(proposal.description);
      }
      setState({ proposal, status: "loaded" });
      setUnclaimedSelection(null);
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
    if (commitMode === "amend") {
      amendDescriptionHydrated.current = true;
      setAmendDescription(value);
    } else {
      commitDescriptionHydrated.current = true;
      setCommitDescription(value);
    }
  };
  const changeUnclaimed = (path: string, checked: boolean) => {
    if (committing || state.status !== "loaded" || state.proposal.status !== "proposed") return;
    const dirt = state.proposal.unclaimedDirt;
    if (!dirt || !proposalId) return;
    setUnclaimedSelection(current => {
      const selected = current?.proposalId === proposalId ? current.changes.map(change => change.path) : [];
      const paths = checked ? [...selected, path] : selected.filter(candidate => candidate !== path);
      const changes = dirt.changes.filter(change => paths.includes(change.path));
      return changes.length ? { proposalId, tree: dirt.tree, changes } : null;
    });
  };
  const changeTitle = (value: string) => {
    if (commitMode === "amend") {
      amendTitleHydrated.current = true;
      setAmendTitle(value);
    } else {
      commitTitleHydrated.current = true;
      setCommitTitle(value);
    }
  };

  return (
    <ThreadCheckpointCommitCard
      commitMode={commitMode}
      committing={committing}
      description={description}
      embedded={embedded}
      freshCommitAvailable={freshCommitAvailable}
      includeNewer={includeNewer}
      messageAvailability={{
        title: commitMode === "amend" ? amendTitleHydrated.current : commitTitleHydrated.current,
        description: commitMode === "amend" ? amendDescriptionHydrated.current : commitDescriptionHydrated.current,
      }}
      onCommit={() => void commit()}
      onCommitModeChange={setCommitMode}
      onDescriptionChange={changeDescription}
      onIncludeNewerChange={setIncludeNewer}
      onUnclaimedOpen={() => setIncludeUnclaimed(true)}
      onUnclaimedChange={changeUnclaimed}
      selectedUnclaimedPaths={unclaimedSelection?.proposalId === proposalId ? unclaimedSelection.changes.map(change => change.path) : []}
      onRetry={() => void loadProposal()}
      onTitleChange={changeTitle}
      observationRef={setObservationTarget}
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

export default function ThreadCheckpointCommitControllerRoot(props: ThreadCheckpointCommitControllerProps) {
  const presentation = useContext(ThreadGitArcPresentationContext);
  const proposalObservation = useThreadGitArcProposalObservation(props.proposalId);
  const harness = props.harness ?? presentation?.harness ?? "codex";
  const resolvedIntent = props.intent ?? (props.proposalId ? presentation?.proposalIntents?.get(props.proposalId) ?? null : null);
  if (!props.proposalId && (
    props.commandOutcome === "failed" || props.commandOutcome === "declined" || props.commandOutcome === "timedOut"
  )) {
    return (
      <ThreadGitArcItem
        commandIntent={{ action: "propose", intentName: null, paths: [], ref: null }}
        durationMs={null}
        failureReason={props.failureReason}
        outcome={props.commandOutcome}
        projectFilePaths={props.projectFilePaths}
        projectId={props.projectId}
        projectRootPath={props.projectRootPath}
        receipt={null}
        workspaceRoots={props.workspaceRoots}
      />
    );
  }
  if (!props.cwd) {
    return (
      <ThreadCheckpointCommitCard
        commitMode={resolvedIntent?.amend ? "amend" : "commit"}
        committing={false}
        description={resolvedIntent?.description ?? ""}
        embedded={props.embedded}
        freshCommitAvailable={Boolean(resolvedIntent?.amend && resolvedIntent.freshTitle?.trim())}
        includeNewer={false}
        onCommit={() => undefined}
        onCommitModeChange={() => undefined}
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
        state={{ status: "idle" }}
        title={resolvedIntent?.title ?? "Commit proposal"}
        workspaceRoots={props.workspaceRoots}
      />
    );
  }
  return (
    <ThreadCheckpointCommitController
      {...props}
      cwd={props.cwd}
      harness={harness}
      intent={resolvedIntent}
      isProposalObserved={proposalObservation.isObserved}
      observeProposal={proposalObservation.observe}
      proposalObservation={proposalObservation.state}
    />
  );
}
