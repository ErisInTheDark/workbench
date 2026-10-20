/*
 * Exports:
 * - default ThreadAnimationStyleContext: the animation thread views present streamed text, items and blocks with, and whether text reveals block by block.
 */
"use client";

import { createContext } from "react";

import { THREAD_ANIMATION_STYLES, type ThreadAnimation } from "../../../workbench/thread/thread-animation-styles";

const ThreadAnimationStyleContext = createContext<ThreadAnimation>({ ...THREAD_ANIMATION_STYLES.soft, perParagraph: false });

export default ThreadAnimationStyleContext;
