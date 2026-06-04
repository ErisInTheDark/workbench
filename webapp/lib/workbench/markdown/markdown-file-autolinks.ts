/*
 * Exports:
 * - ParsedPlaintextProjectFileLink: resolved plaintext project-file autolink range and target metadata. Keywords: markdown, file link, autolink.
 * - parsePlaintextProjectFileLink: recognize bare project file paths in thread markdown. Keywords: markdown, plaintext, file link.
 */

import type { InlineMentionHighlightSources } from "../thread/inline-mention-highlights";
import {
  type WorkspaceFileLinkRoot,
  resolveProjectFileLinkTarget,
} from "./markdown-links";

export interface ParsedPlaintextProjectFileLink {
  columnNumber: number | null;
  end: number;
  href: string;
  lineNumber: number | null;
  relativePath: string;
  start: number;
}

const TRAILING_PUNCTUATION_PATTERN = /[.,;!?)}\]]+$/;
const RELATIVE_FILE_PATH_PATTERN = /^(?:\.{1,2}[\\/])?[A-Za-z0-9_.@-][A-Za-z0-9_.@\-\\/]*\.[A-Za-z0-9][A-Za-z0-9_.-]*(?::\d+(?::\d+)?)?/;
const ABSOLUTE_FILE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)[^\s<>"`|]+/;

function stripTrailingPunctuation(value: string) {
  return value.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function getFileCandidatePaths(inlineMentionSources: InlineMentionHighlightSources | null | undefined) {
  return inlineMentionSources?.fileCandidatePaths ?? [];
}

function isAutolinkBoundary(value: string | undefined) {
  return !value || /\s|[(\[{<>"'`]/.test(value);
}

function getPlaintextFilePathCandidate(markdown: string, index: number) {
  const source = markdown.slice(index);
  const absoluteMatch = ABSOLUTE_FILE_PATH_PATTERN.exec(source);
  if (absoluteMatch) {
    return stripTrailingPunctuation(absoluteMatch[0]);
  }

  const relativeMatch = RELATIVE_FILE_PATH_PATTERN.exec(source);
  if (!relativeMatch) {
    return null;
  }

  const candidate = stripTrailingPunctuation(relativeMatch[0]);
  return candidate.includes("/") || candidate.includes("\\") || candidate.startsWith("./")
    ? candidate
    : null;
}

export function parsePlaintextProjectFileLink(
  markdown: string,
  index: number,
  {
    candidatePaths = null,
    inlineMentionSources = null,
    threadCwdPath = "",
    projectRootPath = "",
    workspaceRoots = [],
  }: {
    candidatePaths?: readonly string[] | null;
    inlineMentionSources?: InlineMentionHighlightSources | null;
    threadCwdPath?: string;
    projectRootPath?: string;
    workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  } = {},
): ParsedPlaintextProjectFileLink | null {
  if (!isAutolinkBoundary(markdown[index - 1])) {
    return null;
  }

  const candidate = getPlaintextFilePathCandidate(markdown, index);
  if (!candidate) {
    return null;
  }

  const resolvedTarget = resolveProjectFileLinkTarget(candidate, {
    candidatePaths: candidatePaths ?? getFileCandidatePaths(inlineMentionSources),
    threadCwdPath,
    projectRootPath,
    workspaceRoots,
  });
  if (!resolvedTarget) {
    return null;
  }

  return {
    ...resolvedTarget,
    end: index + candidate.length,
    href: candidate,
    start: index,
  };
}
