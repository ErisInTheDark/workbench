/*
 * Exports:
 * - default ThreadCheckpointDiffItem: render checkpoint diff command output from legacy inline diffs or compact full-diff artifacts. Keywords: thread, checkpoint, diff, artifact.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import type { FileUpdateChange } from "../../../lib/codex/generated/app-server/v2/FileUpdateChange";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  parseGitCheckpointDiffArtifactId,
  parseGitCheckpointDiffOutput,
} from "../../../lib/workbench/thread/thread-command-matchers";
import { ThreadFileChangeList } from "./ThreadFileChangeItem";

type CheckpointDiffState =
  | { error: string; status: "error" }
  | { changes: FileUpdateChange[]; status: "loaded" }
  | { status: "loading" }
  | { status: "idle" };

function buildFullDiffRequestBody({
  cwd,
  diffArtifactId,
  projectId,
  threadId,
}: {
  cwd: string;
  diffArtifactId: string;
  projectId?: string | null;
  threadId: string;
}) {
  return {
    action: "diff",
    cwd,
    diffArtifactId,
    ...(projectId ? { projectId } : {}),
    threadId,
    view: "full",
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
    void fetch("/api/git-checkpoint", {
      body: JSON.stringify(buildFullDiffRequestBody({
        cwd,
        diffArtifactId,
        projectId,
        threadId,
      })),
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: abortController.signal,
    }).then(async (response) => {
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text.trim() || "Unable to load checkpoint diff artifact.");
      }

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
        error: error instanceof Error ? error.message : "Unable to load checkpoint diff artifact.",
        status: "error",
      });
    });

    return () => abortController.abort();
  }, [cwd, diffArtifactId, legacyChanges.length, projectId, threadId]);

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
      <p className="m-0 py-2 text-[0.92em] leading-[1.6] text-danger">
        {state.error}
      </p>
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
