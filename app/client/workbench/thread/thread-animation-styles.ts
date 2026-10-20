/*
 * Exports:
 * - ThreadMotion: one Web Animations entrance, or null for none.
 * - ThreadAnimationStyle: the text, item and block motions one user-facing style picks together.
 * - ThreadAnimation: a style plus whether streaming text reveals block by block.
 * - THREAD_ANIMATION_STYLES: every style by setting value.
 */
import type { WorkbenchThreadAnimationStyle } from "workbench-shared/workbench/settings/workbench-setting-definitions";

export interface ThreadMotion {
  duration: number;
  easing: string;
  /** Built per element, so motions can measure what they reveal. */
  keyframes: (element: HTMLElement) => Keyframe[];
}

export interface ThreadAnimationStyle {
  /** Newly revealed text runs; inline, so motion uses relative offsets rather than transforms. */
  text: ThreadMotion | null;
  /** New thread items arriving below. */
  item: ThreadMotion | null;
  /** Framed blocks (code, tables, notices, lists, plans) first appearing in streamed text. */
  block: ThreadMotion | null;
  /** A caret rides the end of streaming text. */
  caret: boolean;
}

export interface ThreadAnimation extends ThreadAnimationStyle {
  /** Streaming text holds each block until it is complete; headings and containers wait for their first complete content. */
  perParagraph: boolean;
}

const SETTLE = "cubic-bezier(0.22, 1, 0.36, 1)";

const motions = {
  blurRise: { duration: 240, easing: "cubic-bezier(0.22, 0.82, 0.28, 1)", keyframes: () => [
    { filter: "blur(0.14em)", opacity: 0, top: "0.12em" }, { filter: "blur(0)", opacity: 1, top: "0" },
  ] },
  fade: { duration: 320, easing: "ease-out", keyframes: () => [{ opacity: 0 }, { opacity: 1 }] },
  ink: { duration: 750, easing: "ease-out", keyframes: () => [
    { filter: "blur(2px)", opacity: 0 }, { filter: "blur(0.5px)", offset: 0.4, opacity: 0.55 }, { filter: "blur(0)", opacity: 1 },
  ] },
  pop: { duration: 260, easing: "ease-out", keyframes: () => [
    { filter: "blur(0.08em)", opacity: 0, top: "0.2em" }, { offset: 0.7, opacity: 1, top: "-0.04em" }, { filter: "blur(0)", opacity: 1, top: "0" },
  ] },
  slide: { duration: 220, easing: SETTLE, keyframes: () => [{ left: "-0.4em", opacity: 0 }, { left: "0", opacity: 1 }] },
  slideBlock: { duration: 260, easing: SETTLE, keyframes: () => [{ opacity: 0, transform: "translateX(-0.75rem)" }, { opacity: 1, transform: "none" }] },
  /** drop-shadow follows the block's own rounded shape, unlike box-shadow on the reveal wrapper. */
  glowBlock: { duration: 800, easing: "ease-out", keyframes: () => [
    { filter: "drop-shadow(0 0 0.45em var(--accent))", opacity: 0 },
    { filter: "drop-shadow(0 0 0.35em var(--accent))", offset: 0.2, opacity: 1 },
    { filter: "drop-shadow(0 0 0 transparent)", opacity: 1 },
  ] },
  glow: { duration: 700, easing: "ease-out", keyframes: () => [
    { color: "var(--accent)", opacity: 0, textShadow: "0 0 0.6em var(--accent)" },
    { color: "var(--accent)", offset: 0.2, opacity: 1 },
    { textShadow: "0 0 0 transparent" },
  ] },
  rise: { duration: 260, easing: SETTLE, keyframes: () => [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }] },
  scale: { duration: 220, easing: "ease-out", keyframes: () => [{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }] },
  blur: { duration: 300, easing: "ease-out", keyframes: () => [{ filter: "blur(6px)", opacity: 0 }, { filter: "blur(0)", opacity: 1 }] },
  wipe: { duration: 360, easing: SETTLE, keyframes: () => [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }] },
  expand: { duration: 380, easing: SETTLE, keyframes: (element) => [
    { height: "0px", opacity: 0, overflow: "hidden" },
    { height: `${element.scrollHeight}px`, offset: 0.5, opacity: 0, overflow: "hidden" },
    { height: `${element.scrollHeight}px`, opacity: 1, overflow: "hidden" },
  ] },
} satisfies Record<string, ThreadMotion>;

export const THREAD_ANIMATION_STYLES = {
  soft: { block: motions.expand, caret: false, item: motions.rise, text: motions.blurRise },
  calm: { block: motions.fade, caret: false, item: motions.rise, text: motions.fade },
  ink: { block: motions.blur, caret: false, item: motions.blur, text: motions.ink },
  pop: { block: motions.scale, caret: false, item: motions.scale, text: motions.pop },
  glide: { block: motions.slideBlock, caret: false, item: motions.wipe, text: motions.slide },
  glow: { block: motions.glowBlock, caret: false, item: motions.rise, text: motions.glow },
  typewriter: { block: null, caret: true, item: null, text: null },
} satisfies Record<WorkbenchThreadAnimationStyle, ThreadAnimationStyle>;
