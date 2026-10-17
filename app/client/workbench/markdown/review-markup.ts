/*
 * Exports:
 * - REVIEW_ATTRIBUTES: editor DOM attributes carrying comments, suggestions and preserved markdown source.
 * - CommentThreadKind: inline threads sit in text; block threads sit between blocks as their own lines.
 * - escapeAttribute: escape text for a double-quoted HTML attribute.
 * - isCommentThreadElement / getCommentThreadKind: whether a node is a comment thread atom, and which kind.
 * - readThreadComments / writeThreadComments: the notes a thread atom holds.
 * - commentThreadHtml: markup for a thread atom, as the markdown renderer writes it.
 * - createCommentThreadElement: a live thread atom.
 * - nextSuggestionId: a fresh id grouping the blocks of one suggestion.
 * - getSuggestionId / getSuggestionOld: read a block's suggestion membership.
 * - inheritSuggestionMembership: keep a rebuilt block in its source block's suggestion.
 */

import type { MarkdownComment } from "./comment-markdown";

export const REVIEW_ATTRIBUTES = {
  comments: "data-comments",
  commentThread: "data-comment-thread",
  source: "data-md-source",
  sourceTight: "data-md-tight",
  suggestion: "data-suggestion",
  suggestionEmpty: "data-suggestion-empty",
  suggestionOld: "data-suggestion-old",
} as const;

export type CommentThreadKind = "inline" | "block";

export function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function isCommentThreadElement(node: Node | null | undefined): boolean {
  return node instanceof HTMLElement && node.hasAttribute(REVIEW_ATTRIBUTES.commentThread);
}

export function getCommentThreadKind(element: HTMLElement): CommentThreadKind {
  return element.getAttribute(REVIEW_ATTRIBUTES.commentThread) === "block" ? "block" : "inline";
}

function isMarkdownComment(value: unknown): value is MarkdownComment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.author === null || typeof candidate.author === "string")
    && typeof candidate.body === "string"
    && (candidate.raw === undefined || typeof candidate.raw === "string");
}

export function readThreadComments(element: HTMLElement): MarkdownComment[] {
  try {
    const parsed: unknown = JSON.parse(element.getAttribute(REVIEW_ATTRIBUTES.comments) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isMarkdownComment) : [];
  } catch {
    return [];
  }
}

export function writeThreadComments(element: HTMLElement, comments: readonly MarkdownComment[]) {
  element.setAttribute(REVIEW_ATTRIBUTES.comments, JSON.stringify(comments));
}

export function commentThreadHtml(kind: CommentThreadKind, comments: readonly MarkdownComment[], attributes = "") {
  const tag = kind === "block" ? "aside" : "span";
  return `<${tag} ${REVIEW_ATTRIBUTES.commentThread}="${kind}" contenteditable="false" ${REVIEW_ATTRIBUTES.comments}="${escapeAttribute(JSON.stringify(comments))}"${attributes}></${tag}>`;
}

export function createCommentThreadElement(ownerDocument: Document, kind: CommentThreadKind, comments: readonly MarkdownComment[]) {
  const element = ownerDocument.createElement(kind === "block" ? "aside" : "span");
  element.setAttribute(REVIEW_ATTRIBUTES.commentThread, kind);
  element.setAttribute("contenteditable", "false");
  writeThreadComments(element, comments);
  return element;
}

let suggestionCounter = 0;

export function nextSuggestionId() {
  suggestionCounter += 1;
  return `s${suggestionCounter.toString(36)}`;
}

export function getSuggestionId(node: Node | null | undefined) {
  return node instanceof HTMLElement ? node.getAttribute(REVIEW_ATTRIBUTES.suggestion) : null;
}

export function getSuggestionOld(element: HTMLElement) {
  return element.getAttribute(REVIEW_ATTRIBUTES.suggestionOld) ?? "";
}

/** A block rebuilt from another (retagged, wrapped, unwrapped) stays in the suggestion its source belonged to. */
export function inheritSuggestionMembership(from: Element | null, to: Element) {
  const id = from?.getAttribute(REVIEW_ATTRIBUTES.suggestion);
  if (!from || id === null || id === undefined) {
    return;
  }

  to.setAttribute(REVIEW_ATTRIBUTES.suggestion, id);
  to.setAttribute(REVIEW_ATTRIBUTES.suggestionOld, from.getAttribute(REVIEW_ATTRIBUTES.suggestionOld) ?? "");
}
