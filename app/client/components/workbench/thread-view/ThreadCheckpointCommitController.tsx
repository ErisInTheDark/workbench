/*
 * Exports:
 * - ThreadCheckpointCommitControllerProps: identify one proposal controller and its presentation inputs.
 * - default ThreadCheckpointCommitController: demand near-visible proposal state and chosen inclusion variants from the observing thread (showing the observed summary until it loads; unobserved surfaces read for themselves), own edit and commit actions, and register commit-all readiness.
 */
"use client";

import { defaultProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { GitArcProposalCommitEntry, GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
} from "workbench-shared/workbench/git/git-arc-failures";
import type { WorkbenchGitArcProposalSummary } from "workbench-shared/workbench/thread/thread-state";
import type { GitCheckpointCommitCommandIntent } from "../../../workbench/thread/thread-command-matchers";
import ThreadCheckpointCommitCard, {
  canCommitCheckpointProposal,
  type CheckpointCommitCardState,
} from "./ThreadCheckpointCommitCard";
import { ThreadCheckpointCommitActionsContext, type ThreadCheckpointCommitOutcome } from "./ThreadCheckpointCommitActions";
import { proposalIntentOwnsMessage } from "./thread-git-arc-presentation";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import { useThreadGitArcProposalObservation } from "./ThreadGitArcObservationContext";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import type { ThreadGitArcProposalObservation, ThreadGitArcProposalVariant } from "../../../workbench/thread/ThreadGitArcProposalObserver";

export interface ThreadCheckpointCommitControllerProps {
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
  proposalSummary,
}: ThreadCheckpointCommitControllerProps & {
  cwd: string;
  harness: WorkbenchHarness;
  isProposalObserved: boolean;
  observeProposal: ((proposalId: string, variant?: ThreadGitArcProposalVariant) => () => void) | null;
  proposalObservation: ThreadGitArcProposalObservation | null;
  /** The observed lifecycle's summary: shown while the full proposal hydrates, instead of skeletons. */
  proposalSummary: WorkbenchGitArcProposalSummary | null;
}) {
  const daemon = useWorkbenchDaemonClient();
  // A running batched acceptance is an observed fact, so every tab shows which card is landing and which wait.
  const { acceptance } = useThreadGitArcProposalObservation(proposalId);
  const [includeNewer, setIncludeNewer] = useState(false);
  const [includeUnclaimed, setIncludeUnclaimed] = useState(false);
  // Keep the inspected content with the choice so refresh cannot silently approve changed files.
  const [unclaimedSelection, setUnclaimedSelection] = useState<{
    proposalId: string;
    tree: string;
    changes: GitCheckpointProposal["changes"];
  } | null>(null);
  const intentOwnsMessage = proposalIntentOwnsMessage(intent);
  const intentOwnsAmend = Boolean(intent?.mode === "amend" && intentOwnsMessage);
  const intentOwnsCommit = Boolean(intent?.freshTitle?.trim() || (intent?.mode === "commit" && intentOwnsMessage));
  // The observed summary is the stored message, so it fills whatever the intent does not, from the first paint.
  const seedAmend = proposalSummary?.mode === "amend" && !intentOwnsAmend ? proposalSummary : null;
  const seedCommit = proposalSummary?.mode === "commit" && !intentOwnsCommit ? proposalSummary : null;
  const initialMode = intent?.mode ?? proposalSummary?.mode ?? "commit";
  const [commitMode, setCommitMode] = useState<"amend" | "commit">(initialMode);
  const [amendTitle, setAmendTitle] = useState(seedAmend?.title ?? (intent?.mode === "amend" ? intent.title : ""));
  const [amendDescription, setAmendDescription] = useState(seedAmend?.description ?? (intent?.mode === "amend" ? intent.description : ""));
  const [commitTitle, setCommitTitle] = useState(
    seedCommit?.title ?? intent?.freshTitle ?? (intent?.mode === "commit" ? intent.title : ""),
  );
  const [commitDescription, setCommitDescription] = useState(
    seedCommit?.description ?? (intent?.freshTitle ? intent.freshDescription : intent?.mode === "commit" ? intent.description : "") ?? "",
  );
  const [committing, setCommitting] = useState(false);
  // Synchronous guard so a card click and commit-all cannot both start the same commit.
  const committingRef = useRef(false);
  const loadedModeRef = useRef<"amend" | "commit" | null>(null);
  const commitActions = useContext(ThreadCheckpointCommitActionsContext);
  const [observationTarget, setObservationTarget] = useState<HTMLElement | null>(null);
  const latestSummary = useRef(proposalSummary);
  /** Not loaded yet: the observed summary when Git has been read, otherwise a skeleton. */
  const hydratingState = useCallback((): CheckpointCommitCardState => latestSummary.current
    ? { status: "summary", summary: latestSummary.current }
    : { status: "pending" }, []);
  const [state, setState] = useState<CheckpointCommitCardState>(() => proposalObservation
    ? proposalObservation.status === "loaded"
      ? { proposal: proposalObservation.proposal, status: "loaded" }
      : proposalObservation.status === "failed"
        ? { error: proposalObservation.error, failure: proposalObservation.failure, retryable: true, status: "error" }
        : hydratingState()
    : proposalId ? hydratingState() : { status: "idle" });
  useEffect(() => {
    latestSummary.current = proposalSummary;
    // A hydrating card follows the newest summary; loaded, failed and idle cards keep their own state.
    if (proposalSummary) {
      setState(current => current.status === "pending" || current.status === "summary"
        ? { status: "summary", summary: proposalSummary }
        : current);
    }
  }, [proposalSummary]);
  const amendTitleHydrated = useRef(intentOwnsAmend || Boolean(seedAmend));
  const amendDescriptionHydrated = useRef(intentOwnsAmend || Boolean(seedAmend));
  const commitTitleHydrated = useRef(intentOwnsCommit || Boolean(seedCommit));
  const commitDescriptionHydrated = useRef(intentOwnsCommit || Boolean(seedCommit));
  const title = commitMode === "amend" ? amendTitle : commitTitle;
  const description = commitMode === "amend" ? amendDescription : commitDescription;
  const freshCommitAvailable = Boolean(intent?.freshTitle?.trim());

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
    if (intent.mode === "amend") {
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
    if (intent.freshTitle?.trim()) {
      if (!commitTitleHydrated.current) {
        commitTitleHydrated.current = true;
        setCommitTitle(intent.freshTitle);
      }
      if (!commitDescriptionHydrated.current) {
        commitDescriptionHydrated.current = true;
        setCommitDescription(intent.freshDescription ?? "");
      }
      return;
    }
    if (intent.mode === "commit" && !commitTitleHydrated.current && intent.title.trim()) {
      commitTitleHydrated.current = true;
      setCommitTitle(intent.title);
    }
    if (intent.mode === "commit" && !commitDescriptionHydrated.current && intent.title.trim()) {
      commitDescriptionHydrated.current = true;
      setCommitDescription(intent.description);
    }
  }, [intent]);

  // The observed summary is the stored message, so it fills whatever the intent did not before the card loads.
  const summaryMode = proposalSummary?.mode ?? null;
  const summaryTitle = proposalSummary?.title ?? null;
  const summaryDescription = proposalSummary?.description ?? null;
  useEffect(() => {
    if (summaryMode === null || summaryTitle === null || summaryDescription === null || loadedModeRef.current) return;
    const [titleHydrated, descriptionHydrated, setTitle, setDescription] = summaryMode === "amend"
      ? [amendTitleHydrated, amendDescriptionHydrated, setAmendTitle, setAmendDescription]
      : [commitTitleHydrated, commitDescriptionHydrated, setCommitTitle, setCommitDescription];
    if (!titleHydrated.current) {
      titleHydrated.current = true;
      setTitle(summaryTitle);
    }
    if (!descriptionHydrated.current) {
      descriptionHydrated.current = true;
      setDescription(summaryDescription);
    }
    if (!intent || intent.mode === null) setCommitMode(summaryMode);
  }, [intent, summaryDescription, summaryMode, summaryTitle]);

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
    loadedModeRef.current = proposal.mode;
    if (proposal.status !== "proposed" || intent?.mode === null) setCommitMode(proposal.mode);
    if (!proposal.includeNewerAvailable && includeNewer) setIncludeNewer(false);
    setState({ proposal, status: "loaded" });
  }, [includeNewer, intent?.mode]);

  const loadProposal = useCallback(async (signal?: AbortSignal) => {
    if (!proposalId) return;
    setState((current) => current.status === "loaded" ? current : hydratingState());
    try {
      const proposal = await daemon.git.arc.proposal.read(
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
  }, [acceptProposal, cwd, daemon, harness, hydratingState, includeNewer, includeUnclaimed, proposalId, threadId]);

  // Including newer work or unclaimed dirt is its own observed read, demanded while chosen.
  const variantActive = includeNewer || includeUnclaimed;
  const variantObservation = useThreadGitArcProposalObservation(variantActive ? proposalId : null, { includeNewer, includeUnclaimed }).state;
  useEffect(() => {
    if (!isProposalObserved || !variantActive || !proposalId || !observeProposal) return;
    return observeProposal(proposalId, { includeNewer, includeUnclaimed });
  }, [includeNewer, includeUnclaimed, isProposalObserved, observeProposal, proposalId, variantActive]);

  useEffect(() => {
    if (!isProposalObserved) return;
    if (!proposalId) {
      setState({ status: "idle" });
      return;
    }
    const observation = variantActive ? variantObservation : proposalObservation;
    if (!observation || observation.status === "loading") {
      // A changed inclusion keeps showing the loaded card until its own read lands.
      setState(current => variantActive && current.status === "loaded" ? current : hydratingState());
      return;
    }
    if (observation.status === "failed") {
      setState({
        error: observation.error,
        failure: observation.failure,
        retryable: true,
        status: "error",
      });
      return;
    }
    acceptProposal(observation.proposal);
  }, [acceptProposal, hydratingState, isProposalObserved, proposalId, proposalObservation, variantActive, variantObservation]);

  // Surfaces outside an observing thread read for themselves.
  useEffect(() => {
    if (isProposalObserved) return;
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

  /** The card's current commit choices, shared by its own commit and batched commit-all. */
  const entry = (): GitArcProposalCommitEntry | null => {
    if (!proposalId || !title.trim()) return null;
    return {
      description,
      includeNewer,
      ...(unclaimedSelection?.proposalId === proposalId && unclaimedSelection.changes.length ? {
        unclaimedSelection: {
          paths: unclaimedSelection.changes.map(change => change.path),
          tree: unclaimedSelection.tree,
        },
      } : {}),
      // A rehydrating card keeps the last loaded mode, so a fresh-commit choice survives HEAD movement.
      ...(loadedModeRef.current === "amend" && commitMode === "commit"
        ? { mode: "commit" as const }
        : {}),
      proposalId,
      title,
    };
  };
  const settle = (outcome: ThreadCheckpointCommitOutcome) => {
    if ("proposal" in outcome) {
      const { proposal } = outcome;
      setCommitMode(proposal.mode);
      if (proposal.mode === "amend") {
        setAmendTitle(proposal.title);
        setAmendDescription(proposal.description);
      } else {
        setCommitTitle(proposal.title);
        setCommitDescription(proposal.description);
      }
      loadedModeRef.current = proposal.mode;
      setState({ proposal, status: "loaded" });
      setUnclaimedSelection(null);
      return;
    }
    const { error } = outcome;
    const failure = error instanceof GitArcFailureException
      ? error.failure
      : createGitArcOperationRejected("proposalCommit", error instanceof Error ? error.message : "Unable to commit checkpoint proposal.");
    setState({
      error: error instanceof Error ? error.message : "Unable to commit checkpoint proposal.",
      failure,
      retryable: true,
      status: "error",
    });
  };
  const commit = async () => {
    const choices = entry();
    if (!choices || committingRef.current) return false;
    committingRef.current = true;
    setCommitting(true);
    try {
      settle({ proposal: await daemon.git.arc.proposal.commit({ ...choices, cwd, harness, threadId }) });
      return true;
    } catch (error) {
      settle({ error });
      return false;
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  };
  const latest = useRef({ entry, settle });
  useEffect(() => { latest.current = { entry, settle }; });
  const commitReady = state.status === "loaded"
    && state.proposal.status === "proposed"
    && canCommitCheckpointProposal({
      commitMode,
      committing,
      description,
      proposal: state.proposal,
      selectedUnclaimedCount: unclaimedSelection?.proposalId === proposalId ? unclaimedSelection.changes.length : 0,
      title,
    });

  useEffect(() => {
    if (!commitActions || !proposalId) return;
    return commitActions.register(proposalId, {
      entry: () => latest.current.entry(),
      loaded: state.status === "loaded",
      ready: commitReady,
      settle: outcome => latest.current.settle(outcome),
    });
  }, [commitActions, commitReady, proposalId, state.status]);

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
      committing={committing || acceptance === "landing"}
      queued={acceptance === "queued"}
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
  const harness = props.harness ?? presentation?.harness ?? defaultProviderKey;
  const resolvedIntent = props.intent ?? (props.proposalId ? presentation?.proposalIntents?.get(props.proposalId) ?? null : null);
  if (!props.cwd) {
    const resolvedMode = resolvedIntent?.mode ?? proposalObservation.summary?.mode ?? "commit";
    return (
      <ThreadCheckpointCommitCard
        commitMode={resolvedMode}
        committing={false}
        description={resolvedIntent?.description ?? ""}
        embedded={props.embedded}
        freshCommitAvailable={Boolean(resolvedIntent?.freshTitle?.trim())}
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
      proposalSummary={proposalObservation.summary}
    />
  );
}
