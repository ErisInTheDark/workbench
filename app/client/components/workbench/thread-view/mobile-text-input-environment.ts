/*
 * Exports:
 * - isMobileTextInputEnvironment: detect soft-keyboard-oriented input contexts for Enter-key behavior.
 * - useMobileTextInputEnvironment: the same check, re-rendering when it changes.
 */
"use client";

import useMediaQuery from "../../../workbench/dom/layout/use-media-query";

const MOBILE_TEXT_INPUT_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

export function isMobileTextInputEnvironment () {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_TEXT_INPUT_MEDIA_QUERY).matches;
}

export function useMobileTextInputEnvironment () {
  return useMediaQuery(MOBILE_TEXT_INPUT_MEDIA_QUERY);
}
