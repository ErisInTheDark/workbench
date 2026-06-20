/*
 * Exports:
 * - default ThreadMarkdown: render cached thread markdown with project, workspace, and external absolute file links. Keywords: thread markdown, file links, external git roots.
 */
"use client";

import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ResolveExternalFileLinkRootsResponse } from "../../../lib/types";
import { collectPlaintextAbsoluteFileLinkPaths } from "../../../lib/workbench/markdown/markdown-file-autolinks";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import { normalizeWorkbenchPath, type WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import { renderThreadMarkdown } from "./thread-markdown-render";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

const THREAD_MARKDOWN_CLASS = [
  "min-w-0",
  "max-w-full",
  "leading-[1.72]",
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
        const response = await fetch("/api/file/link-roots", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ paths: unresolvedPaths }),
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          for (const path of unresolvedPaths) {
            externalFileLinkRootCache.set(path, null);
          }
          setVersion((current) => current + 1);
          return;
        }

        const payload = await response.json().catch(() => null) as ResolveExternalFileLinkRootsResponse | null;
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
  }, [paths]);

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

export default memo(function ThreadMarkdown ({
  className,
  inlineMentionSources,
  markdown,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const projectFilePathsKey = getProjectFilePathsCacheKey(projectFilePaths);
  const externalFileLinkRoots = useExternalFileLinkRoots(markdown);
  const resolvedWorkspaceRoots = useMemo(
    () => mergeWorkspaceRoots(workspaceRoots, externalFileLinkRoots),
    [externalFileLinkRoots, workspaceRoots],
  );
  const cacheKey = getMarkdownCacheKey({
    inlineMentionSources,
    markdown,
    threadCwdPath,
    projectFilePathsKey,
    projectId,
    projectRootPath,
    workspaceRoots: resolvedWorkspaceRoots,
  });
  const renderedMarkdown = useMemo(
    () => renderCachedThreadMarkdown(
      markdown,
      { inlineMentionSources, threadCwdPath, projectFilePaths, projectId, projectRootPath, workspaceRoots: resolvedWorkspaceRoots },
      cacheKey,
    ),
    [cacheKey, inlineMentionSources, markdown, threadCwdPath, projectFilePaths, projectId, projectRootPath, resolvedWorkspaceRoots],
  );

  return (
    <div
      className={joinClasses(THREAD_MARKDOWN_CLASS, className)}
    >
      {renderedMarkdown}
    </div>
  );
});
