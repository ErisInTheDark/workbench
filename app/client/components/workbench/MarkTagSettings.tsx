/*
 * Exports:
 * - default MarkTagSettings: edit a mark tag list as an input list whose rows show their Alt shortcut digit, drag to
 *   reorder (which reassigns shortcuts) and pick their colour; names commit when focus leaves, other changes at once.
 */
"use client";

import { useState } from "react";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  MARK_TAG_COLORS,
  MARK_TAG_LIMIT,
  MARK_TAG_NAME_MAX_LENGTH,
  MarkTag,
  type MarkTagColor,
} from "workbench-shared/workbench/settings/mark-tags";
import { markTagColorValue } from "../../workbench/editor/mark-tag-styles";
import { describeKeybind, markTagKeybind } from "../../workbench/editor/editor-commands";
import { isApplePlatform } from "../ui/Keybind";
import PressDragMenu from "../ui/PressDragMenu";
import InputList from "./InputList";
import { InputListRows, type InputListRow } from "./input-list-rows";

type MarkTagRow = InputListRow<{ color: MarkTagColor }>;

const COLOR_LABELS: Record<MarkTagColor, string> = {
  blue: "Blue", green: "Green", orange: "Orange", pink: "Pink", purple: "Purple", red: "Red", teal: "Teal", white: "White",
  yellow: "Yellow",
};

function rowsFor(tags: readonly MarkTag[]): MarkTagRow[] {
  return InputListRows.create<{ color: MarkTagColor }>(tags.map(tag => ({ color: tag.color, value: tag.name })), MARK_TAG_LIMIT);
}

/** Rows typed into without a colour yet take the palette's least used one, in list order. */
function effectiveColors(rows: readonly MarkTagRow[]) {
  const colors = new Map<string, MarkTagColor>();
  const assigned: Array<{ color: MarkTagColor }> = [];
  for (const row of rows) {
    const color = row.color ?? MarkTag.nextColor(assigned);
    colors.set(row.id, color);
    if (!InputListRows.isBlank(row)) assigned.push({ color });
  }
  return colors;
}

function tagsFor(rows: readonly MarkTagRow[]) {
  const colors = effectiveColors(rows);
  return MarkTag.normalizeList(InputListRows.populated(rows).map(row => ({ color: colors.get(row.id), name: row.value })));
}

/** Typing waits for focus to leave the list; reordering, recolouring and removing save at once. */
function changesMoreThanNames(previous: readonly MarkTagRow[], next: readonly MarkTagRow[]) {
  const nextIds = new Set(next.map(row => row.id));
  if (InputListRows.populated(previous).some(row => !nextIds.has(row.id))) return true;
  const kept = next.filter(row => previous.some(old => old.id === row.id)).map(row => row.id);
  const order = previous.filter(row => nextIds.has(row.id)).map(row => row.id);
  return kept.some((id, index) => id !== order[index])
    || next.some(row => previous.some(old => old.id === row.id && old.color !== row.color));
}

function Swatch({ color }: { color: MarkTagColor }) {
  return <span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ background: markTagColorValue(color) }} />;
}

export default function MarkTagSettings({ disabled, label, onChange, value }: {
  disabled?: boolean;
  label: string;
  onChange: (tags: MarkTag[]) => void;
  value: readonly MarkTag[];
}) {
  const [rows, setRows] = useState(() => rowsFor(value));
  const [shown, setShown] = useState(value);
  // Saved tags that changed elsewhere (another window, a reset) replace an edit that does not already match them.
  if (shown !== value && !areDeeplyEqual(shown, value)) {
    setShown(value);
    if (!areDeeplyEqual(tagsFor(rows), value)) setRows(rowsFor(value));
  }

  const colors = effectiveColors(rows);
  const apple = isApplePlatform();
  const errors = Object.fromEntries(rows.flatMap((row, index) => {
    const name = MarkTag.normalizeName(row.value);
    if (row.value.trim().length > MARK_TAG_NAME_MAX_LENGTH) return [[row.id, `Names are ${MARK_TAG_NAME_MAX_LENGTH} characters at most.`]];
    const duplicate = name && rows.slice(0, index).some(other => MarkTag.normalizeName(other.value) === name);
    return duplicate ? [[row.id, "Another tag already has this name; only the first one is kept."]] : [];
  }));

  function commit(next: readonly MarkTagRow[]) {
    const tags = tagsFor(next);
    if (!areDeeplyEqual(tags, value)) onChange(tags);
  }

  return (
    <div onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) commit(rows);
    }}>
      <InputList<{ color: MarkTagColor }>
        disabled={disabled}
        errors={errors}
        idPrefix="mark-tag"
        limit={MARK_TAG_LIMIT}
        onRowsChange={next => {
          setRows(next);
          if (changesMoreThanNames(rows, next)) commit(next);
        }}
        placeholder={rows.length > 1 ? "Add a tag" : "Name a tag, such as bad or rethink"}
        renderLeading={(row, index) => (
          <kbd
            aria-label={describeKeybind(markTagKeybind(index), apple).join("+")}
            title={`${describeKeybind(markTagKeybind(index), apple).join("+")} in suggest mode`}
            className={`
              inline-flex h-[1.35rem] min-w-[1.35rem] items-center justify-center rounded-[0.4rem] px-1 font-sans
              text-[0.72rem] font-medium leading-none tabular-nums
              ${InputListRows.isBlank(row) ? "bg-fg/4 text-fg/40" : "bg-fg/8 text-fg/70"}
            `}
          >
            {MarkTag.keyDigit(index)}
          </kbd>
        )}
        renderTrailing={(row, edit) => {
          // The blank row is where a tag is typed; it becomes a tag, with a colour, on its first character.
          if (InputListRows.isBlank(row)) return null;
          const color = colors.get(row.id) ?? MARK_TAG_COLORS[0];
          return (
            <PressDragMenu
              label={`Colour of ${row.value.trim() || "new tag"}: ${COLOR_LABELS[color]}`}
              align="end"
              disabled={disabled}
              triggerAppearance="plain"
              triggerClassName="size-7 justify-center rounded-md hover:bg-surface-hover"
              items={MARK_TAG_COLORS.map(candidate => ({
                id: candidate,
                checked: candidate === color,
                content: <span className="flex items-center gap-2.5"><Swatch color={candidate} />{COLOR_LABELS[candidate]}</span>,
              }))}
              onSelect={id => {
                if (MarkTag.isColor(id)) edit({ color: id });
              }}
            >
              <Swatch color={color} />
            </PressDragMenu>
          );
        }}
        reorderable
        rowLabel={label}
        rows={rows}
      />
    </div>
  );
}
