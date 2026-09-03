/*
 * Exports:
 * - isMobileTextInputEnvironment: detect soft-keyboard-oriented input contexts for Enter-key behavior. Keywords: mobile, keyboard, input.
 * - useMobileTextInputEnvironment: subscribe to mobile text-input media query changes. Keywords: mobile, keyboard, hook.
 */
"use client";

import { useEffect, useState } from "react";

const MOBILE_TEXT_INPUT_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

export function isMobileTextInputEnvironment () {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_TEXT_INPUT_MEDIA_QUERY).matches;
}

export function useMobileTextInputEnvironment () {
  const [isMobileTextInput, setIsMobileTextInput] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(MOBILE_TEXT_INPUT_MEDIA_QUERY);
    const applyMatch = () => {
      setIsMobileTextInput(mediaQuery.matches);
    };

    applyMatch();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", applyMatch);
    } else {
      mediaQuery.addListener(applyMatch);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", applyMatch);
      } else {
        mediaQuery.removeListener(applyMatch);
      }
    };
  }, []);

  return isMobileTextInput;
}
