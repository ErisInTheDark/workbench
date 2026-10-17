/*
 * Exports:
 * - CommentMarginLayout: comment threads either sit in a margin column right of the text, or open from badges inline.
 * - EditorMarginLayout: where comments and suggestion originals go, and how far the text column shifts to make room.
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
const ORIGINAL_MIN_WIDTH_PX = 224;

const INITIAL_LAYOUT: EditorMarginLayout = {
  comments: { mode: "inline" },
  shellOffset: null,
  suggestion: { mode: "below", width: 0 },
};

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

  const originalSpace = (shellOffset ?? centredSpace) + editor.offsetLeft - MARGIN_GAP_PX;
  const originalWidth = Math.min(editor.offsetWidth, originalSpace - MARGIN_GAP_PX / 2);
  return {
    comments,
    shellOffset,
    suggestion: originalWidth >= ORIGINAL_MIN_WIDTH_PX ? { mode: "beside", width: Math.round(originalWidth) } : { mode: "below", width: 0 },
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
