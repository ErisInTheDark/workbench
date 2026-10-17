/*
 * Exports:
 * - CommentMarginLayout: comment threads either sit in a margin column right of the text, or open from badges inline.
 * - EditorMarginLayout: where comments and suggestion rows go, and how far the text column shifts to make room.
 * - default useEditorMarginLayout: measure the pane around an editor shell and lay out its margins.
 */
"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import type { SuggestionLayout } from "../../../workbench/editor/WorkbenchSuggestionController";

export type CommentMarginLayout =
  | { mode: "margin"; left: number; width: number }
  | { mode: "inline" };

export interface EditorMarginLayout {
  comments: CommentMarginLayout;
  /** Left margin of the shell when it moves off-centre to fit the comment margin; null keeps it centred. */
  shellOffset: number | null;
  suggestion: SuggestionLayout;
}

const MARGIN_GAP_PX = 16;
const COMMENT_MIN_WIDTH_PX = 216;
const COMMENT_MAX_WIDTH_PX = 320;
export const SUGGESTION_COLUMN_GAP_PX = 32;
const SUGGESTION_COLUMN_MIN_WIDTH_PX = 300;
/** On narrow panes the hidden column peeks in by this much, hinting that the row scrolls. */
const SUGGESTION_PEEK_PX = 28;

const INITIAL_LAYOUT: EditorMarginLayout = {
  comments: { mode: "inline" },
  shellOffset: null,
  suggestion: { newLeft: 0, oldLeft: 0, viewportLeft: 0, viewportWidth: 0, width: 0 },
};

/**
 * A suggestion row is wider than the text column: two columns centred on it, as wide as the text each where the pane
 * allows, kept inside the pane. A pane too narrow for two readable columns shows one at a time and scrolls the row.
 */
function measureSuggestionRow(paneWidth: number, shellLeft: number, editor: HTMLElement): SuggestionLayout {
  const viewportWidth = paneWidth - MARGIN_GAP_PX * 2;
  const viewportLeft = MARGIN_GAP_PX - shellLeft;
  const rowWidth = Math.min(viewportWidth, editor.offsetWidth * 2 + SUGGESTION_COLUMN_GAP_PX);
  const sharedWidth = Math.floor((rowWidth - SUGGESTION_COLUMN_GAP_PX) / 2);
  if (sharedWidth < SUGGESTION_COLUMN_MIN_WIDTH_PX) {
    const width = Math.max(0, viewportWidth - SUGGESTION_COLUMN_GAP_PX - SUGGESTION_PEEK_PX);
    return { newLeft: viewportLeft + width + SUGGESTION_COLUMN_GAP_PX, oldLeft: viewportLeft, viewportLeft, viewportWidth, width };
  }

  const editorCentre = shellLeft + editor.offsetLeft + editor.offsetWidth / 2;
  const rowLeft = Math.min(Math.max(MARGIN_GAP_PX, editorCentre - rowWidth / 2), paneWidth - MARGIN_GAP_PX - rowWidth);
  const oldLeft = Math.round(rowLeft - shellLeft);
  return { newLeft: oldLeft + sharedWidth + SUGGESTION_COLUMN_GAP_PX, oldLeft, viewportLeft, viewportWidth, width: sharedWidth };
}

function measure(shell: HTMLElement, editor: HTMLElement, hasThreads: boolean): EditorMarginLayout {
  const pane = shell.parentElement;
  if (!pane) return INITIAL_LAYOUT;

  const paneWidth = pane.clientWidth;
  const shellWidth = shell.offsetWidth;
  const editorRight = editor.offsetLeft + editor.offsetWidth;
  const centredSpace = Math.max(0, (paneWidth - shellWidth) / 2);
  const freeSpace = Math.max(0, paneWidth - shellWidth);

  let shellOffset: number | null = null;
  let comments: CommentMarginLayout = { mode: "inline" };
  if (hasThreads) {
    const needed = COMMENT_MIN_WIDTH_PX + MARGIN_GAP_PX * 2;
    if (centredSpace >= needed) {
      comments = { mode: "margin", left: editorRight + MARGIN_GAP_PX, width: Math.min(COMMENT_MAX_WIDTH_PX, centredSpace - MARGIN_GAP_PX * 2) };
    } else if (freeSpace >= needed) {
      const width = Math.min(COMMENT_MAX_WIDTH_PX, freeSpace - MARGIN_GAP_PX * 2);
      shellOffset = Math.max(0, freeSpace - width - MARGIN_GAP_PX * 2);
      comments = { mode: "margin", left: editorRight + MARGIN_GAP_PX, width };
    }
  }

  // A shell narrower than the pane is centred unless shifted for comments; a wider one keeps its own (mobile) position.
  const shellLeft = shellOffset ?? (freeSpace > 0 ? centredSpace : shell.offsetLeft);
  return {
    comments,
    shellOffset,
    suggestion: measureSuggestionRow(paneWidth, shellLeft, editor),
  };
}

function sameLayout(left: EditorMarginLayout, right: EditorMarginLayout) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function useEditorMarginLayout(
  shellRef: RefObject<HTMLElement | null>,
  editorRef: RefObject<HTMLElement | null>,
  hasThreads: boolean,
) {
  const [layout, setLayout] = useState(INITIAL_LAYOUT);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const editor = editorRef.current;
    const pane = shell?.parentElement;
    if (!shell || !editor || !pane) return;

    const update = () => {
      const next = measure(shell, editor, hasThreads);
      setLayout((current) => sameLayout(current, next) ? current : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(pane);
    observer?.observe(shell);
    return () => observer?.disconnect();
  }, [editorRef, hasThreads, shellRef]);

  return layout;
}
