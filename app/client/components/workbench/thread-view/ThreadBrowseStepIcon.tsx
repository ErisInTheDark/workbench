/*
 * Exports:
 * - default ThreadBrowseStepIcon: the icon for one BrowseMD step's action; a running step spins, a failed one warns.
 */
"use client";

import type { ComponentType } from "react";

import type { ThreadCommandDetailRow } from "../../../workbench/thread/thread-command-matchers";
import {
  AppWindowIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, CodeIcon, EyeIcon, FileCodeIcon, HighlighterIcon, ImageIcon,
  KeyboardIcon, ListIcon, LoaderIcon, MousePointerIcon, RefreshCwIcon, RulerIcon, SearchIcon, SquareIcon,
  TextCursorInputIcon, UnfoldVerticalIcon, WarningIcon, type IconProps,
} from "../workbench-icons";

const ACTION_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  back: ChevronLeftIcon,
  click: MousePointerIcon,
  cursor: MousePointerIcon,
  eval: CodeIcon,
  fill: TextCursorInputIcon,
  forward: ChevronRightIcon,
  get: SearchIcon,
  highlight: HighlighterIcon,
  "init-js": FileCodeIcon,
  is: SearchIcon,
  key: KeyboardIcon,
  mouse: MousePointerIcon,
  mouseClick: MousePointerIcon,
  open: AppWindowIcon,
  reload: RefreshCwIcon,
  screenshot: ImageIcon,
  scroll: UnfoldVerticalIcon,
  select: ListIcon,
  snapshot: EyeIcon,
  stop: SquareIcon,
  type: KeyboardIcon,
  viewport: RulerIcon,
  wait: ClockIcon,
};

export default function ThreadBrowseStepIcon({ row }: { row: ThreadCommandDetailRow }) {
  if (row.state === "inProgress") return <LoaderIcon className="shrink-0" size={14} />;
  if (row.state === "failed") return <WarningIcon className="shrink-0 text-danger" size={14} />;
  const Icon = (row.action && ACTION_ICONS[row.action]) || AppWindowIcon;
  return <Icon className={`shrink-0 ${row.state === "queued" ? "opacity-50" : ""}`} size={14} />;
}
