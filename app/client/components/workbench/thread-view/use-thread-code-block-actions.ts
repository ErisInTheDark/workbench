/*
 * Exports:
 * - default useThreadCodeBlockActions: own a thread view's code-block copy feedback and wrap toggles; returns its click handler.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import { writeTextToClipboard } from "../../../workbench/dom/clipboard";

const COPY_FEEDBACK_MS = 1500;

type CopyState = "copied" | "failed" | "idle";

function setCopyButtonState (button: HTMLButtonElement, state: CopyState) {
  button.setAttribute("data-thread-codeblock-copy-state", state);
  button.setAttribute(
    "aria-label",
    state === "copied" ? "Copied code block" : state === "failed" ? "Code block copy failed" : "Copy code block",
  );
  button.title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code block";
}

function setToggleButtonState (button: HTMLButtonElement, isActive: boolean) {
  button.setAttribute("aria-pressed", isActive ? "true" : "false");
  button.setAttribute("data-thread-codeblock-toggle-state", isActive ? "active" : "idle");
}

/** Code blocks render as static markup; the view root delegates their buttons' clicks here and mirrors wrap onto them. */
export default function useThreadCodeBlockActions (
  rootRef: RefObject<HTMLDivElement | null>,
  wrap: boolean,
  onWrapChange: (nextValue: boolean) => void,
) {
  const resetTimersRef = useRef<Map<HTMLButtonElement, number>>(new Map());

  useEffect(() => () => {
    resetTimersRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    resetTimersRef.current.clear();
  }, []);

  const syncWrap = useCallback((nextValue: boolean) => {
    const root = rootRef.current;
    if (!root) return;
    root.setAttribute("data-thread-codeblock-wrap", nextValue ? "true" : "false");
    root.querySelectorAll<HTMLButtonElement>("button[data-thread-codeblock-wrap-toggle]").forEach((button) => {
      setToggleButtonState(button, nextValue);
    });
  }, [rootRef]);

  useLayoutEffect(() => {
    syncWrap(wrap);
  }, [syncWrap, wrap]);

  const showCopyFeedback = useCallback((button: HTMLButtonElement, state: Exclude<CopyState, "idle">) => {
    const existingTimeoutId = resetTimersRef.current.get(button);
    if (existingTimeoutId !== undefined) window.clearTimeout(existingTimeoutId);
    setCopyButtonState(button, state);
    const timeoutId = window.setTimeout(() => {
      setCopyButtonState(button, "idle");
      resetTimersRef.current.delete(button);
    }, COPY_FEEDBACK_MS);
    resetTimersRef.current.set(button, timeoutId);
  }, []);

  const copy = useCallback(async (button: HTMLButtonElement) => {
    const root = rootRef.current;
    const codeBlock = button.closest<HTMLElement>("[data-thread-codeblock='true']");
    const code = codeBlock?.querySelector<HTMLElement>("[data-thread-codeblock-code='true']");
    if (!root || !root.contains(button) || !code) return;
    const didCopy = await writeTextToClipboard(code.textContent ?? "");
    if (!root.contains(button)) return;
    showCopyFeedback(button, didCopy ? "copied" : "failed");
  }, [rootRef, showCopyFeedback]);

  return useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const target = event.target instanceof Element ? event.target : null;
    const copyButton = target?.closest<HTMLButtonElement>("button[data-thread-codeblock-copy]") ?? null;
    if (copyButton && root?.contains(copyButton)) {
      void copy(copyButton);
      return;
    }
    const toggle = target?.closest<HTMLButtonElement>("button[data-thread-codeblock-wrap-toggle]") ?? null;
    if (!toggle || !root?.contains(toggle)) return;
    const nextValue = root.getAttribute("data-thread-codeblock-wrap") !== "true";
    syncWrap(nextValue);
    onWrapChange(nextValue);
  }, [copy, onWrapChange, rootRef, syncWrap]);
}
