/*
 * Exports:
 * - WorkbenchTabStrip: ordered open tabs (route path tails) and the one italic preview tab, if any.
 * - WorkbenchTabStrip namespace: apply open, pin, close and replace rules.
 */

/**
 * A tab is one destination in the url tab list (`thread/<owner>/<id>`, `settings`) without the project selection,
 * so the strip survives selection changes. The preview tab is the one a plain navigation replaces.
 */
export interface WorkbenchTabStrip {
  readonly tabs: readonly string[];
  readonly preview: number | null;
}

function shiftPreview(preview: number | null, insertedAt: number) {
  return preview !== null && preview >= insertedAt ? preview + 1 : preview;
}

export const WorkbenchTabStrip = {
  empty: { tabs: [], preview: null } as WorkbenchTabStrip,

  /**
   * Opening an open tab focuses it (pinning it when `durable`). Otherwise a plain open replaces the preview tab, or
   * becomes the new preview after `focused`; a durable open inserts a kept tab there instead.
   */
  open(strip: WorkbenchTabStrip, tab: string, { durable = false, focused = null }: { durable?: boolean; focused?: string | null } = {}): WorkbenchTabStrip {
    const existing = strip.tabs.indexOf(tab);
    if (existing >= 0) return durable ? WorkbenchTabStrip.pin(strip, tab) : strip;
    if (!durable && strip.preview !== null) {
      return { tabs: strip.tabs.map((candidate, index) => index === strip.preview ? tab : candidate), preview: strip.preview };
    }
    const focusedIndex = focused === null ? -1 : strip.tabs.indexOf(focused);
    const insertAt = focusedIndex >= 0 ? focusedIndex + 1 : strip.tabs.length;
    const tabs = [...strip.tabs.slice(0, insertAt), tab, ...strip.tabs.slice(insertAt)];
    return { tabs, preview: durable ? shiftPreview(strip.preview, insertAt) : insertAt };
  },

  pin(strip: WorkbenchTabStrip, tab: string): WorkbenchTabStrip {
    return strip.preview !== null && strip.tabs[strip.preview] === tab ? { tabs: strip.tabs, preview: null } : strip;
  },

  /** Closing the focused tab focuses its right neighbour, or the left one at the end; `focus` is null when none remain. */
  close(strip: WorkbenchTabStrip, tab: string, focused: string | null): { strip: WorkbenchTabStrip; focus: string | null } {
    const index = strip.tabs.indexOf(tab);
    if (index < 0) return { strip, focus: focused };
    const tabs = strip.tabs.filter((_candidate, position) => position !== index);
    const preview = strip.preview === null || strip.preview === index ? null
      : strip.preview > index ? strip.preview - 1 : strip.preview;
    const focus = tab !== focused ? focused : tabs[Math.min(index, tabs.length - 1)] ?? null;
    return { strip: { tabs, preview }, focus };
  },

  /** A destination that moved (a draft becoming a thread, save as) keeps its tab's place and preview state. */
  replace(strip: WorkbenchTabStrip, from: string, to: string): WorkbenchTabStrip {
    if (from === to) return strip;
    const index = strip.tabs.indexOf(from);
    if (index < 0) return WorkbenchTabStrip.open(strip, to);
    const duplicate = strip.tabs.indexOf(to);
    if (duplicate >= 0) return WorkbenchTabStrip.close(strip, from, from).strip;
    return { tabs: strip.tabs.map((candidate, position) => position === index ? to : candidate), preview: strip.preview };
  },
};
