/*
 * Exports:
 * - default MarkdownRender: render cached thread markdown with the contextual project's file, workspace and mention links plus external absolute file links; live text fades in and streaming text renders its frontier, or only complete blocks under per-paragraph reveal. Keywords: thread markdown, file links, external git roots, streaming.
 * - Local helpers: bound rendered Markdown and external-root caches, and own one reveal timeline per live render context that never replays or re-hides text already shown. Keywords: cache, markdown, reveal.
 */
"use client";

import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ResolveExternalFileLinkRootsResponse } from "workbench-shared/types";
import { collectPlaintextAbsoluteFileLinkPaths } from "../../workbench/markdown/markdown-file-autolinks";
import type { InlineMentionHighlightSources } from "../../workbench/thread/inline-mention-highlights";
import { normalizeWorkbenchPath, type WorkspaceFileLinkRoot } from "../../workbench/markdown/markdown-links";
import MarkdownRevealTimeline from "../../workbench/markdown/MarkdownRevealTimeline";
import { renderThreadMarkdown } from "../workbench/thread-view/thread-markdown-render";
import { useWorkbenchDaemonClient } from "../workbench/WorkbenchWorkspaceContext";
import { useProject } from "../workbench/use-projects";
import ThreadAnimationStyleContext from "../workbench/thread-view/ThreadAnimationStyleContext";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

const THREAD_MARKDOWN_CLASS = [
  "min-w-0",
  "max-w-full",
  "leading-[1.72]",
  "[:where(&)]:text-fg/94",
  "[&:not(:first-child)]:mt-[0.2rem]",
].join(" ");

const MAX_RENDERED_THREAD_MARKDOWN_CACHE_ENTRIES = 320;
const MAX_RENDERED_THREAD_MARKDOWN_CACHE_MARKDOWN_CHARS = 300_000;
const projectFilePathsCacheKeys = new WeakMap<readonly string[], string>();
const renderedThreadMarkdownCache = new Map<string, {
  markdownLength: number;
  value: ReactNode;
}>();
let renderedThreadMarkdownCacheMarkdownChars = 0;
const externalFileLinkRootCache = new Map<string, WorkspaceFileLinkRoot | null>();

function getStringListCacheKey(values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return `${values.length}:${(hash >>> 0).toString(36)}`;
}

function getProjectFilePathsCacheKey(projectFilePaths: readonly string[] | undefined) {
  if (!projectFilePaths) {
    return "files:none";
  }

  const cachedKey = projectFilePathsCacheKeys.get(projectFilePaths);
  if (cachedKey) {
    return cachedKey;
  }

  const key = `files:${getStringListCacheKey(projectFilePaths)}`;
  projectFilePathsCacheKeys.set(projectFilePaths, key);
  return key;
}

function getMarkdownCacheKey({
  inlineMentionSources,
  markdown,
  threadCwdPath,
  projectFilePathsKey,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
  threadCwdPath?: string;
  projectFilePathsKey: string;
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return [
    markdown,
    inlineMentionSources?.cacheKey ?? "mentions:none",
    projectFilePathsKey,
    projectId ?? "",
    projectRootPath ?? "",
    threadCwdPath ?? "",
    workspaceRoots?.map((root) => `${root.id}:${root.openPathMode ?? ""}:${root.projectId ?? ""}:${root.rootPath}`).join(";") ?? "",
  ].join("|");
}

function mergeWorkspaceRoots(
  baseRoots: readonly WorkspaceFileLinkRoot[] | undefined,
  externalRoots: readonly WorkspaceFileLinkRoot[],
) {
  if (!externalRoots.length) {
    return baseRoots;
  }

  const roots: WorkspaceFileLinkRoot[] = [];
  const seenRootPaths = new Set<string>();
  for (const root of [...(baseRoots ?? []), ...externalRoots]) {
    const rootPathKey = normalizeWorkbenchPath(root.rootPath).toLowerCase();
    if (!rootPathKey || seenRootPaths.has(rootPathKey)) {
      continue;
    }

    seenRootPaths.add(rootPathKey);
    roots.push(root);
  }

  return roots;
}

function readCachedExternalFileLinkRoots(paths: readonly string[]) {
  const roots: WorkspaceFileLinkRoot[] = [];
  const seenRootPaths = new Set<string>();
  for (const path of paths) {
    const root = externalFileLinkRootCache.get(path);
    if (!root) {
      continue;
    }

    const rootPathKey = normalizeWorkbenchPath(root.rootPath).toLowerCase();
    if (!rootPathKey || seenRootPaths.has(rootPathKey)) {
      continue;
    }

    seenRootPaths.add(rootPathKey);
    roots.push(root);
  }

  return roots;
}

function useExternalFileLinkRoots(markdown: string) {
  const daemon = useWorkbenchDaemonClient();
  const [version, setVersion] = useState(0);
  const paths = useMemo(() => collectPlaintextAbsoluteFileLinkPaths(markdown), [markdown]);

  useEffect(() => {
    const unresolvedPaths = paths.filter((path) => !externalFileLinkRootCache.has(path));
    if (!unresolvedPaths.length) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const payload: ResolveExternalFileLinkRootsResponse | null = await daemon.nativeFiles.linkRoots(
          { paths: unresolvedPaths },
        );
        const roots = Array.isArray(payload?.roots) ? payload.roots : [];
        for (const path of unresolvedPaths) {
          const normalizedPath = normalizeWorkbenchPath(path);
          const root = roots.find((candidate) => {
            const normalizedRootPath = normalizeWorkbenchPath(candidate.rootPath);
            const comparablePath = normalizedPath.toLowerCase();
            const comparableRootPath = normalizedRootPath.toLowerCase();
            return comparablePath === comparableRootPath || comparablePath.startsWith(`${comparableRootPath}/`);
          }) ?? null;

          externalFileLinkRootCache.set(path, root);
        }

        setVersion((current) => current + 1);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to resolve external file link roots", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [daemon, paths]);

  return useMemo(() => readCachedExternalFileLinkRoots(paths), [paths, version]);
}

function readRenderedThreadMarkdownCache(key: string) {
  const cachedEntry = renderedThreadMarkdownCache.get(key);
  if (cachedEntry === undefined) {
    return null;
  }

  renderedThreadMarkdownCache.delete(key);
  renderedThreadMarkdownCache.set(key, cachedEntry);
  return cachedEntry.value;
}

function deleteOldestRenderedThreadMarkdownCacheEntry() {
  const oldestKey = renderedThreadMarkdownCache.keys().next().value;
  if (oldestKey === undefined) {
    return false;
  }

  const oldestEntry = renderedThreadMarkdownCache.get(oldestKey);
  if (oldestEntry) {
    renderedThreadMarkdownCacheMarkdownChars -= oldestEntry.markdownLength;
  }
  renderedThreadMarkdownCache.delete(oldestKey);
  return true;
}

function writeRenderedThreadMarkdownCache(key: string, value: ReactNode, markdownLength: number) {
  const existingEntry = renderedThreadMarkdownCache.get(key);
  if (existingEntry) {
    renderedThreadMarkdownCacheMarkdownChars -= existingEntry.markdownLength;
  }

  renderedThreadMarkdownCache.set(key, {
    markdownLength,
    value,
  });
  renderedThreadMarkdownCacheMarkdownChars += markdownLength;
  while (
    renderedThreadMarkdownCache.size > MAX_RENDERED_THREAD_MARKDOWN_CACHE_ENTRIES
    || renderedThreadMarkdownCacheMarkdownChars > MAX_RENDERED_THREAD_MARKDOWN_CACHE_MARKDOWN_CHARS
  ) {
    if (!deleteOldestRenderedThreadMarkdownCacheEntry()) {
      break;
    }
  }
}

function renderCachedThreadMarkdown(
  markdown: string,
  options: Parameters<typeof renderThreadMarkdown>[1],
  cacheKey: string,
) {
  const cachedValue = readRenderedThreadMarkdownCache(cacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }

  const renderedMarkdown = renderThreadMarkdown(markdown, options);
  writeRenderedThreadMarkdownCache(cacheKey, renderedMarkdown, markdown.length);
  return renderedMarkdown;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/**
 * What this render has already put on screen never animates or hides again, even when a paused turn goes live again
 * (an answered questionnaire). Only text streaming in as the render first shows it fades whole; a later reveal timeline
 * (a changed context, or live again) starts settled, and text once shown whole keeps its last word while it streams.
 */
function useShownText(markdown: string, live: boolean, streaming: boolean, contextKey: string) {
  const timelineRef = useRef<{ contextKey: string; timeline: MarkdownRevealTimeline } | null>(null);
  const shownRef = useRef<{ whole: string | null } | null>(null);
  const partial = streaming && markdown !== shownRef.current?.whole;
  useLayoutEffect(() => {
    shownRef.current = { whole: partial ? shownRef.current?.whole ?? null : markdown };
  }, [markdown, partial]);
  if (!live || prefersReducedMotion()) {
    timelineRef.current = null;
    return { partial, timeline: null };
  }
  if (timelineRef.current?.contextKey !== contextKey) {
    timelineRef.current = { contextKey, timeline: new MarkdownRevealTimeline(streaming && !shownRef.current ? 0 : null) };
  }
  return { partial, timeline: timelineRef.current.timeline };
}

/** Links and mentions resolve against the surrounding contextual project; outside one, markdown renders without project links. */
export default memo(function MarkdownRender ({
  className,
  cwd,
  live = false,
  markdown,
  streaming = false,
}: {
  className?: string;
  /** The directory this text's relative paths came from, when it differs from the contextual project's (a command's own cwd). */
  cwd?: string;
  /** Text presented from a live source: newly visible text fades in. */
  live?: boolean;
  markdown: string;
  /** Text still streaming: its end is the stream frontier, so unfinished tokens hide and open markup closes there. */
  streaming?: boolean;
}) {
  const project = useProject.contextual();
  const externalFileLinkRoots = useExternalFileLinkRoots(markdown);
  const resolvedWorkspaceRoots = useMemo(
    () => mergeWorkspaceRoots(project?.workspaceRoots, externalFileLinkRoots),
    [externalFileLinkRoots, project],
  );
  const threadCwdPath = cwd ?? project?.cwd;
  const keyFacts = {
    inlineMentionSources: project?.mentions,
    projectFilePathsKey: getProjectFilePathsCacheKey(project?.filePaths),
    projectId: project?.id,
    projectRootPath: project?.rootPath,
    threadCwdPath,
    workspaceRoots: resolvedWorkspaceRoots,
  };
  const cacheKey = getMarkdownCacheKey({ ...keyFacts, markdown });
  const contextKey = getMarkdownCacheKey({ ...keyFacts, markdown: "" });
  const renderOptions = useMemo(() => ({
    inlineMentionSources: project?.mentions,
    projectFilePaths: project?.filePaths,
    projectId: project?.id,
    projectRootPath: project?.rootPath,
    threadCwdPath,
    workspaceRoots: resolvedWorkspaceRoots,
  }), [project, resolvedWorkspaceRoots, threadCwdPath]);
  const { partial, timeline } = useShownText(markdown, live, streaming, contextKey);
  const animationStyle = useContext(ThreadAnimationStyleContext);
  const caret = streaming && animationStyle.caret;
  const holdIncompleteBlocks = animationStyle.perParagraph;
  const presentation = useMemo(() => {
    if (!live) return { cursor: null, rendered: renderCachedThreadMarkdown(markdown, renderOptions, cacheKey) };
    const cursor = timeline?.cursor(performance.now()) ?? null;
    return { cursor, rendered: renderThreadMarkdown(markdown, {
      ...renderOptions, caret, holdIncompleteBlocks, partial, reveal: cursor ?? undefined,
    }) };
  }, [cacheKey, caret, holdIncompleteBlocks, live, markdown, partial, renderOptions, timeline]);

  useLayoutEffect(() => {
    if (presentation.cursor) timeline?.commit(presentation.cursor);
  }, [presentation, timeline]);

  return (
    <div
      className={joinClasses(THREAD_MARKDOWN_CLASS, className)}
    >
      {presentation.rendered}
    </div>
  );
});
