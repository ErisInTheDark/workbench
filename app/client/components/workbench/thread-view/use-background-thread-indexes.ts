/*
 * Exports:
 * - useBackgroundInlineMentionSources: a thread view's inline mention sources, served from cache or rebuilt cooperatively.
 * - useBackgroundProjectFilePathDisambiguationIndex: the project's path disambiguation index, served from cache or
 *   rebuilt cooperatively; null until first built.
 * Both share one rebuild queue, so thread views never rebuild indexes on top of each other.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectTreeFileCandidate } from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import {
  createProjectFilePathDisambiguationIndexCooperatively,
  readCachedProjectFilePathDisambiguationIndex,
  writeProjectFilePathDisambiguationIndexCache,
  type ProjectFilePathDisambiguationIndex,
} from "../../../workbench/project/project-file-path";
import CooperativeRebuildQueue from "../../../workbench/state/CooperativeRebuildQueue";
import {
  buildInlineMentionCandidates,
  buildInlineMentionCandidatesCooperatively,
  readCachedInlineMentionCandidates,
  type BuildInlineMentionCandidatesOptions,
  type InlineMentionHighlightSources,
} from "../../../workbench/thread/inline-mention-highlights";

const EMPTY_PROJECT_FILE_CANDIDATES: readonly ProjectTreeFileCandidate[] = [];
const REBUILD_SLICE_MS = 20;
const rebuildQueue = new CooperativeRebuildQueue();

export function useBackgroundInlineMentionSources ({
  files,
  filesIdentity,
  projectRootPath,
  skills,
  threadCwdPath,
  workspaceRoots = [],
}: BuildInlineMentionCandidatesOptions): InlineMentionHighlightSources {
  const fallbackSources = useMemo(() => buildInlineMentionCandidates({
    files: EMPTY_PROJECT_FILE_CANDIDATES,
    filesIdentity: "thread-view:empty-project-files",
    projectRootPath,
    skills,
    threadCwdPath,
    workspaceRoots,
  }), [projectRootPath, skills, threadCwdPath, workspaceRoots]);
  const [sources, setSources] = useState<InlineMentionHighlightSources>(() => (
    readCachedInlineMentionCandidates({ files, filesIdentity, projectRootPath, skills, threadCwdPath, workspaceRoots })
      ?? fallbackSources
  ));
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const options = { files, filesIdentity, projectRootPath, skills, threadCwdPath, workspaceRoots };
    const cachedSources = readCachedInlineMentionCandidates(options);
    if (cachedSources) {
      setSources(cachedSources);
      return;
    }
    rebuildQueue.enqueue({
      key: "thread-view:inline-mention-sources",
      run: budget => buildInlineMentionCandidatesCooperatively(options, budget),
      commit (result) {
        if (generationRef.current === generation) setSources(result);
      },
      onError (error) {
        console.error("Failed to rebuild inline mention sources", error);
      },
      sliceMs: REBUILD_SLICE_MS,
    });
  }, [fallbackSources, files, filesIdentity, projectRootPath, skills, threadCwdPath, workspaceRoots]);

  return sources;
}

export function useBackgroundProjectFilePathDisambiguationIndex (
  disambiguationPaths: readonly string[],
  disambiguationKey: string,
): ProjectFilePathDisambiguationIndex | null {
  const [disambiguationIndex, setDisambiguationIndex] = useState<ProjectFilePathDisambiguationIndex | null>(() => (
    readCachedProjectFilePathDisambiguationIndex(disambiguationPaths, disambiguationKey)
  ));
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const cachedIndex = readCachedProjectFilePathDisambiguationIndex(disambiguationPaths, disambiguationKey);
    if (cachedIndex) {
      setDisambiguationIndex(cachedIndex);
      return;
    }
    rebuildQueue.enqueue({
      key: "thread-view:project-file-path-disambiguation",
      async run (budget) {
        const index = await createProjectFilePathDisambiguationIndexCooperatively(disambiguationPaths, budget);
        writeProjectFilePathDisambiguationIndexCache(disambiguationPaths, disambiguationKey, index);
        return index;
      },
      commit (result) {
        if (generationRef.current === generation) setDisambiguationIndex(result);
      },
      onError (error) {
        console.error("Failed to rebuild project file path disambiguation index", error);
      },
      sliceMs: REBUILD_SLICE_MS,
    });
  }, [disambiguationKey, disambiguationPaths]);

  return disambiguationIndex;
}
