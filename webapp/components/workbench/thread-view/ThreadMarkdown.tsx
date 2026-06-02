"use client";

import { memo, useMemo, type ReactNode } from "react";

import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
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
const projectFilePathsCacheKeys = new WeakMap<readonly string[], string>();
const renderedThreadMarkdownCache = new Map<string, ReactNode>();

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
  projectFilePathsKey,
  projectId,
  projectRootPath,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
  projectFilePathsKey: string;
  projectId?: string | null;
  projectRootPath?: string;
}) {
  return [
    markdown,
    inlineMentionSources?.cacheKey ?? "mentions:none",
    projectFilePathsKey,
    projectId ?? "",
    projectRootPath ?? "",
  ].join("|");
}

function readRenderedThreadMarkdownCache(key: string) {
  const cachedValue = renderedThreadMarkdownCache.get(key);
  if (cachedValue === undefined) {
    return null;
  }

  renderedThreadMarkdownCache.delete(key);
  renderedThreadMarkdownCache.set(key, cachedValue);
  return cachedValue;
}

function writeRenderedThreadMarkdownCache(key: string, value: ReactNode) {
  renderedThreadMarkdownCache.set(key, value);
  while (renderedThreadMarkdownCache.size > MAX_RENDERED_THREAD_MARKDOWN_CACHE_ENTRIES) {
    const oldestKey = renderedThreadMarkdownCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    renderedThreadMarkdownCache.delete(oldestKey);
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
  writeRenderedThreadMarkdownCache(cacheKey, renderedMarkdown);
  return renderedMarkdown;
}

export default memo(function ThreadMarkdown ({
  className,
  inlineMentionSources,
  markdown,
  projectFilePaths,
  projectId,
  projectRootPath,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
}) {
  const projectFilePathsKey = getProjectFilePathsCacheKey(projectFilePaths);
  const cacheKey = getMarkdownCacheKey({
    inlineMentionSources,
    markdown,
    projectFilePathsKey,
    projectId,
    projectRootPath,
  });
  const renderedMarkdown = useMemo(
    () => renderCachedThreadMarkdown(
      markdown,
      { inlineMentionSources, projectFilePaths, projectId, projectRootPath },
      cacheKey,
    ),
    [cacheKey, inlineMentionSources, markdown, projectFilePaths, projectId, projectRootPath],
  );

  return (
    <div
      className={joinClasses(THREAD_MARKDOWN_CLASS, className)}
    >
      {renderedMarkdown}
    </div>
  );
});
