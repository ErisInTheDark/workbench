/*
 * Exports:
 * - getThreadMarkdownEmphasisColors: own supported authored text/background colours independently of lifecycle presentation. Keywords: markdown, colour, notice, icon, palette.
 * - getThreadTextColorStyle: the class or inline style painting `<color>` tag text, keeping hex colours readable in light and dark schemes.
 */

import type { CSSProperties } from "react";

import type { ThreadEmphasisColor, ThreadTextColor } from "../../../workbench/markdown/thread-emphasis-markup";

const THREAD_MARKDOWN_EMPHASIS_COLORS = {
  blue: {
    text: "text-sky-600 dark:text-sky-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-sky-500)_11%,transparent),transparent_88%)]",
  },
  green: {
    text: "text-emerald-600 dark:text-emerald-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-emerald-500)_11%,transparent),transparent_88%)]",
  },
  purple: {
    text: "text-violet-600 dark:text-violet-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-violet-500)_11%,transparent),transparent_88%)]",
  },
  red: {
    text: "text-red-600 dark:text-red-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-red-500)_11%,transparent),transparent_88%)]",
  },
  yellow: {
    text: "text-amber-600 dark:text-amber-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-amber-500)_11%,transparent),transparent_88%)]",
  },
} satisfies Record<ThreadEmphasisColor, { text: string; background: string }>;

/** Lightness bounds near the palette's light (600) and dark (300) text shades; hue and chroma stay as authored. */
const HEX_TEXT_LIGHT_SCHEME_MAX_LIGHTNESS = 0.6;
const HEX_TEXT_DARK_SCHEME_MIN_LIGHTNESS = 0.75;

export function getThreadMarkdownEmphasisColors(color: string) {
  return Object.hasOwn(THREAD_MARKDOWN_EMPHASIS_COLORS, color)
    ? THREAD_MARKDOWN_EMPHASIS_COLORS[color as ThreadEmphasisColor]
    : null;
}

export function getThreadTextColorStyle(color: ThreadTextColor): { className?: string; style?: CSSProperties } {
  if (!color.startsWith("#")) return { className: THREAD_MARKDOWN_EMPHASIS_COLORS[color as ThreadEmphasisColor].text };
  const light = `oklch(from ${color} min(l, ${HEX_TEXT_LIGHT_SCHEME_MAX_LIGHTNESS}) c h)`;
  const dark = `oklch(from ${color} max(l, ${HEX_TEXT_DARK_SCHEME_MIN_LIGHTNESS}) c h)`;
  return { style: { color: `light-dark(${light}, ${dark})` } };
}
