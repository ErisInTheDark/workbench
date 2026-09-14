/*
 * Exports:
 * - getThreadMarkdownEmphasisColors: own supported authored text/background colours independently of lifecycle presentation. Keywords: markdown, colour, notice, icon, palette.
 */

const THREAD_MARKDOWN_EMPHASIS_COLORS = new Map<string, { text: string; background: string }>([
  ["blue", {
    text: "text-sky-600 dark:text-sky-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-sky-500)_11%,transparent),transparent_88%)]",
  }],
  ["green", {
    text: "text-emerald-600 dark:text-emerald-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-emerald-500)_11%,transparent),transparent_88%)]",
  }],
  ["purple", {
    text: "text-violet-600 dark:text-violet-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-violet-500)_11%,transparent),transparent_88%)]",
  }],
  ["red", {
    text: "text-red-600 dark:text-red-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-red-500)_11%,transparent),transparent_88%)]",
  }],
  ["yellow", {
    text: "text-amber-600 dark:text-amber-300",
    background: "bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-amber-500)_11%,transparent),transparent_88%)]",
  }],
]);

export function getThreadMarkdownEmphasisColors(color: string) {
  return THREAD_MARKDOWN_EMPHASIS_COLORS.get(color) ?? null;
}
