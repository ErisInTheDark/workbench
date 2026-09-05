/*
 * Keywords: stats, token categories, colours, icons.
 * Exports:
 * - STATS_TOKEN_SERIES: common presentation and token-count access for the three selectable categories.
 */
import type { ComponentType } from "react";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { StatsTokenType } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { SquareArrowRightEnterIcon, SquareEqualIcon, SquareArrowRightExitIcon } from "../workbench-icons";

export const STATS_TOKEN_SERIES: readonly {
  key: StatsTokenType;
  label: string;
  colourClassName: string;
  Icon: ComponentType<{ className?: string }>;
  count: (tokens: WorkbenchStatsResponse["tokens"]["totals"]) => number;
}[] = [
  { key: "input", label: "Input", colourClassName: "text-hue-210", Icon: SquareArrowRightEnterIcon, count: (tokens) => tokens.uncachedInput },
  { key: "cache", label: "Cache", colourClassName: "text-hue-300", Icon: SquareEqualIcon, count: (tokens) => tokens.cachedInput + tokens.cacheWriteInput },
  { key: "output", label: "Output", colourClassName: "text-hue-140", Icon: SquareArrowRightExitIcon, count: (tokens) => tokens.output },
];
