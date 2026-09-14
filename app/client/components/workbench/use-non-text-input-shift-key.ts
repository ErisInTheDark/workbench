/*
 * Exports:
 * - useNonTextInputShiftKey: track whether Shift is held outside text-entry controls. Keywords: keyboard, shift, input, modifier.
 * - Local helper: identify browser text-entry targets, including contenteditable and textbox roles. Keywords: input, textarea, contenteditable.
 */
"use client";

import { useEffect, useState } from "react";

const TEXT_INPUT_TYPES = new Set(["email", "number", "password", "search", "tel", "text", "url"]);

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const textEntry = target.closest("input, textarea, [contenteditable], [role='textbox']");
  if (!textEntry) return false;
  if (textEntry instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(textEntry.type);
  if (textEntry instanceof HTMLTextAreaElement || textEntry.getAttribute("role") === "textbox") return true;
  return textEntry.getAttribute("contenteditable") !== "false";
}

export function useNonTextInputShiftKey() {
  const [isShiftPressed, setIsShiftPressed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") setIsShiftPressed(!isTextEntryTarget(event.target));
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setIsShiftPressed(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (isTextEntryTarget(event.target)) setIsShiftPressed(false);
    };
    const handleBlur = () => setIsShiftPressed(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return isShiftPressed;
}
