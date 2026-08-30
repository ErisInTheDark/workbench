/*
 * Exports:
 * - default ThreadCheckpointDiffItem: render checkpoint diff command output from legacy inline diffs or compact full-diff artifacts. Keywords: thread, checkpoint, diff, artifact.
 */
"use client";

import { useContext, useEffect, useMemo, useState } from "react";

import type { FileUpdateChange } from "../../../lib/codex/generated/app-server/v2/FileUpdateChange";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  type GitArcFailure,
} from "../../../lib/workbench/git/git-arc-failures";
import {
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
} from "../../../lib/workbench/thread/thread-command-matchers";
import { ThreadFileChangeList } from "./ThreadFileChangeItem";
import ThreadGitArcFailure from "./ThreadGitArcFailure";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";

type CheckpointDiffState =
  | { failure: GitArcFailure; status: "error" }
  | { changes: FileUpdateChange[]; status: "loaded" }
  | { status: "loading" }
  | { status: "idle" };

function buildFullDiffRequestBody({
  cwd,
  diffArtifactId,
  harness,
  threadId,
}: {
  cwd: string;
  diffArtifactId: string;
  harness: "codex" | "copilot" | "opencode";
  threadId: string;
}) {
  return {
    cwd,
    diffArtifactId,
    harness,
    threadId,
  };
}

export default function ThreadCheckpointDiffItem({
  cwd,
  output,
  projectFilePaths,
  projectId,
  projectRootPath,
  sourceItemId,
  threadId,
  workspaceRoots,
}: {
  cwd: string;
  output: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  sourceItemId: string;
  threadId: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const daemon = useWorkbenchDaemonClient();
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);
  const legacyChanges = useMemo(() => parseGitCheckpointDiffOutput(output), [output]);
  const diffArtifactId = useMemo(() => parseGitCheckpointDiffArtifactId(output), [output]);
  const [state, setState] = useState<CheckpointDiffState>({ status: "idle" });

  useEffect(() => {
    if (legacyChanges.length || !diffArtifactId) {
      setState({ status: "idle" });
      return;
    }

    const abortController = new AbortController();
    setState({ status: "loading" });
    void daemon.requestGitArc("git/arc/diff-artifact/read", buildFullDiffRequestBody({
        cwd,
        diffArtifactId,
        harness: gitArcPresentation?.harness ?? "codex",
        threadId,
      })).then((text) => {
      if (!abortController.signal.aborted) {
        setState({
          changes: parseGitCheckpointDiffOutput(text),
          status: "loaded",
        });
      }
    }).catch((error) => {
      if (abortController.signal.aborted) {
        return;
      }

      setState({
        failure: error instanceof GitArcFailureException
          ? error.failure
          : createGitArcOperationRejected("readDiffArtifact", error instanceof Error ? error.message : "Unable to load checkpoint diff artifact."),
        status: "error",
      });
    });

    return () => abortController.abort();
  }, [cwd, daemon, diffArtifactId, gitArcPresentation?.harness, legacyChanges.length, threadId]);

  if (legacyChanges.length) {
    return (
      <ThreadFileChangeList
        changes={legacyChanges.map((change, sourceChangeIndex) => ({
          change,
          sourceChangeIndex,
          sourceItemId,
        }))}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (state.status === "loaded") {
    return (
      <ThreadFileChangeList
        changes={state.changes.map((change, sourceChangeIndex) => ({
          change,
          sourceChangeIndex,
          sourceItemId,
        }))}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (state.status === "error") {
    return (
      <ThreadGitArcFailure
        failure={state.failure}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        workspaceRoots={workspaceRoots}
      />
    );
  }

  if (diffArtifactId) {
    return (
      <p className="m-0 py-2 text-[0.92em] leading-[1.6] text-muted">
        Loading checkpoint diff...
      </p>
    );
  }

  return (
    <ThreadFileChangeList
      changes={[]}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
    />
  );
}
