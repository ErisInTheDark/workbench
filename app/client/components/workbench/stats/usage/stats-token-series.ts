/*
 * Exports:
 * - STATS_TOKEN_SERIES: shared presentation, token-count, and cost access for the selectable billing categories.
 */
import type { ComponentType } from "react";
import type { StatsTokenType, WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { SquareArrowRightEnterIcon, SquareEqualIcon, SquareArrowRightExitIcon, SquarePenIcon, type IconProps } from "../../workbench-icons";

type Tokens = WorkbenchStatsSectionData<"usage">["tokens"]["totals"];

export const STATS_TOKEN_SERIES: readonly {
  key: StatsTokenType;
  label: string;
  description: string;
  hue: number;
  textClassName: string;
  fillClassName: string;
  Icon: ComponentType<IconProps>;
  count: (tokens: Tokens) => number;
}[] = [
  {
    key: "input", label: "Input", description: "Fresh, uncached prompt tokens", hue: 210,
    textClassName: "text-hue-210", fillClassName: "bg-hue-210",
    Icon: SquareArrowRightEnterIcon, count: (tokens) => tokens.uncachedInput,
  },
  {
    key: "cacheRead", label: "Cache read", description: "Prompt tokens served from cache", hue: 300,
    textClassName: "text-hue-300", fillClassName: "bg-hue-300",
    Icon: SquareEqualIcon, count: (tokens) => tokens.cachedInput,
  },
  {
    key: "cacheWrite", label: "Cache write", description: "Prompt tokens written into cache", hue: 85,
    textClassName: "text-hue-85", fillClassName: "bg-hue-85",
    Icon: SquarePenIcon, count: (tokens) => tokens.cacheWriteInput,
  },
  {
    key: "output", label: "Output", description: "Generated tokens, including reasoning", hue: 140,
    textClassName: "text-hue-140", fillClassName: "bg-hue-140",
    Icon: SquareArrowRightExitIcon, count: (tokens) => tokens.output,
  },
];
