/*
 * Exports:
 * - default ThreadAnimationStyleContext: the animation style thread views present streamed text, items and blocks with.
 */
"use client";

import { createContext } from "react";

import { THREAD_ANIMATION_STYLES, type ThreadAnimationStyle } from "../../../workbench/thread/thread-animation-styles";

const ThreadAnimationStyleContext = createContext<ThreadAnimationStyle>(THREAD_ANIMATION_STYLES.soft);

export default ThreadAnimationStyleContext;
