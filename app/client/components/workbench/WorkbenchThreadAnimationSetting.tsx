/*
 * Exports:
 * - default WorkbenchThreadAnimationSetting: thread animation row with the per-paragraph checkbox and a drag menu whose opener and rows play each style live.
 */
"use client";

import type { WorkbenchThreadAnimationStyle } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import { WORKBENCH_SETTING_DEFINITIONS } from "../../workbench/state/workbench-settings";
import PressDragMenu from "../ui/PressDragMenu";
import ThreadAnimationPreview from "./thread-view/ThreadAnimationPreview";
import { useSettings } from "./use-settings";
import WorkbenchCheckbox from "./WorkbenchCheckbox";
import { ChevronDownIcon } from "./workbench-icons";

const definition = WORKBENCH_SETTING_DEFINITIONS.threadAnimationStyle;
const perParagraphDefinition = WORKBENCH_SETTING_DEFINITIONS.threadAnimationPerParagraph;
/** Seven live rows outgrow the default menu cap; past this the menu scrolls. */
const MENU_MAX_HEIGHT = 760;

/** The opener and every menu row render this same row; the description stays available as its tooltip. */
function MotionRow({ perParagraph, selected, style }: { perParagraph: boolean; selected: boolean; style: WorkbenchThreadAnimationStyle }) {
  const option = definition.options?.find(candidate => candidate.value === style);
  return <span title={option?.description} className={`
    flex w-[26.5rem] max-w-full items-center rounded-xl text-left
    ${selected ? "shadow-[inset_0_0_0_2px_var(--accent)]" : ""}
  `}>
    <span className="w-[6.5rem] shrink-0 px-3 text-sm font-medium text-text">{option?.label ?? style}</span>
    <span className="my-1.5 mr-1.5 block h-[7.5rem] min-w-0 flex-1 overflow-hidden rounded-lg bg-fg/4 px-2.5 py-1.5 text-[0.72rem] text-text">
      <ThreadAnimationPreview perParagraph={perParagraph} style={style} />
    </span>
  </span>;
}

export default function WorkbenchThreadAnimationSetting({ onError }: { onError: (message: string) => void }) {
  const settings = useSettings(null);
  const report = (error: Error) => onError(error.message);
  const value = settings.get("threadAnimationStyle");
  const perParagraph = settings.get("threadAnimationPerParagraph");
  const current = definition.options?.find(option => option.value === value);
  const unavailable = settings.unavailable("threadAnimationStyle");
  const perParagraphUnavailable = settings.unavailable("threadAnimationPerParagraph");
  return <section className="flex min-w-0 flex-col items-start gap-2 py-3">
    <h3 className="m-0 text-sm font-semibold text-text">{definition.label}</h3>
    <WorkbenchCheckbox
      checked={perParagraph}
      className="-ml-2 text-sm"
      disabled={perParagraphUnavailable}
      label={perParagraphDefinition.label}
      onChange={next => { void settings.set("threadAnimationPerParagraph", next).catch(report); }}
    />
    <PressDragMenu
      label={`Thread animation: ${current?.label ?? value}`}
      align="start"
      disabled={unavailable}
      flushItems
      maxHeight={MENU_MAX_HEIGHT}
      triggerAppearance="plain"
      triggerClassName="max-w-full rounded-xl"
      items={(definition.options ?? []).map(option => ({
        id: option.value,
        checked: option.value === value,
        content: <MotionRow perParagraph={perParagraph} selected={option.value === value} style={option.value} />,
      }))}
      onSelect={id => {
        const option = definition.options?.find(item => item.value === id);
        if (option) void settings.set("threadAnimationStyle", option.value).catch(report);
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <MotionRow perParagraph={perParagraph} selected style={value} />
        <ChevronDownIcon size={16} className="shrink-0 text-fg/muted" />
      </span>
    </PressDragMenu>
    {unavailable || perParagraphUnavailable
      ? <p className="m-0 w-full text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
  </section>;
}
