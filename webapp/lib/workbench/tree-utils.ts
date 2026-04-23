/**
 * Exports:
 * - treeContainsFilePath: check whether a nested workbench tree contains a specific file path. Keywords: tree traversal, file lookup, recursion, explorer.
 * - formatTimestamp: format a timestamp string for workbench display using the current locale. Keywords: dates, time, Intl.DateTimeFormat, UI display.
 * - isMarkdownFile: detect markdown file paths by extension. Keywords: markdown, extension, file type.
 * - isTextLikeFile: detect text-editable file paths by extension or extensionless name. Keywords: text file, editable, extension, workbench.
 * - getFirstFile: find the first file path in a nested tree that matches an optional predicate. Keywords: tree traversal, first match, recursion, file selection.
 */

import type { TreeNode } from "../types";

export function treeContainsFilePath(nodes: TreeNode[], filePath: string): boolean {
  for (const node of nodes) {
    if (node.type === "file" && node.path === filePath) {
      return true;
    }
    if (node.type === "directory" && treeContainsFilePath(node.children, filePath)) {
      return true;
    }
  }

  return false;
}

export function formatTimestamp(value: string) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function isMarkdownFile(filePath: string) {
  return /\.md(?:own)?$/i.test(filePath);
}

export function isTextLikeFile(filePath: string) {
  return /\.(?:md|txt|json|js|mjs|cjs|css|html|yml|yaml|toml|gitignore)$/i.test(filePath) || !/\.[a-z0-9]+$/i.test(filePath);
}

export function getFirstFile(nodes: TreeNode[], predicate: (filePath: string) => boolean = () => true) {
  for (const node of nodes) {
    if (node.type === "file" && predicate(node.path)) {
      return node.path;
    }
    if (node.type === "directory") {
      const nested = getFirstFile(node.children, predicate);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}
