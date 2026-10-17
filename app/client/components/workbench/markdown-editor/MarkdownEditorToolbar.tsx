/*
 * Exports:
 * - default MarkdownEditorToolbar: the markdown editor's persistent toolbar: edit/suggest mode, formatting, comments and
 *   history, acting on the editor selection without taking it.
 */
"use client";

import { useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { describeKeybind, EDITOR_COMMANDS, type EditorCommand } from "../../../workbench/editor/editor-commands";
import type { ReviewMode } from "../../../workbench/editor/WorkbenchSuggestionController";
import type { EditorToolbarState } from "../../../workbench/WorkbenchEditorClient";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import Keybind, { isApplePlatform } from "../../ui/Keybind";
import PressDragMenu from "../../ui/PressDragMenu";
import Tooltip from "../../ui/Tooltip";
import ChevronIcon from "../ChevronIcon";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  MessageSquareDiffIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Redo2Icon,
  TextQuoteIcon,
  Undo2Icon,
} from "../workbench-icons";

const DISABLED_STATE: EditorToolbarState = {
  block: null,
  editable: false,
  inline: { bold: false, code: false, del: false, ins: false, italic: false },
  reviewMode: "edit",
};

const noSubscription = () => () => {};
const disabledState = () => DISABLED_STATE;

interface ToolbarItem {
  command: EditorCommand;
  icon: ReactNode;
  isActive?: (state: EditorToolbarState) => boolean;
}

const GROUPS: ReadonlyArray<readonly ToolbarItem[]> = [
  [
    { command: "bold", icon: <BoldIcon size={16} />, isActive: (state) => state.inline.bold },
    { command: "italic", icon: <ItalicIcon size={16} />, isActive: (state) => state.inline.italic },
    { command: "inline-code", icon: <CodeIcon size={16} />, isActive: (state) => state.inline.code },
  ],
  [
    { command: "h1", icon: <Heading1Icon size={16} />, isActive: (state) => state.block === "h1" },
    { command: "h2", icon: <Heading2Icon size={16} />, isActive: (state) => state.block === "h2" },
    { command: "h3", icon: <Heading3Icon size={16} />, isActive: (state) => state.block === "h3" },
    { command: "quote", icon: <TextQuoteIcon size={16} />, isActive: (state) => state.block === "blockquote" },
    { command: "unordered-list", icon: <ListIcon size={16} />, isActive: (state) => state.block === "ul" },
    { command: "ordered-list", icon: <ListOrderedIcon size={16} />, isActive: (state) => state.block === "ol" },
  ],
  [
    { command: "comment", icon: <MessageSquarePlusIcon size={16} /> },
  ],
];

const MODES: Record<ReviewMode, { description: string; icon: ReactNode; label: string }> = {
  edit: { description: "Change the text directly", icon: <PencilIcon size={16} />, label: "Edit" },
  suggest: { description: "Keep the original beside every change", icon: <MessageSquareDiffIcon size={16} />, label: "Suggest" },
};
const MODE_ORDER: readonly ReviewMode[] = ["edit", "suggest"];

function CommandTooltip({ children, command }: { children: ComponentProps<typeof Tooltip>["children"]; command: EditorCommand }) {
  const { keybinds, label } = EDITOR_COMMANDS[command];
  const keybind = keybinds[0];
  return (
    <Tooltip
      placement="bottom"
      delayMs={350}
      content={
        <span className="flex items-center gap-2.5 whitespace-nowrap">
          <span>{label}</span>
          {keybind ? <Keybind keys={describeKeybind(keybind, isApplePlatform())} /> : null}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-fg/10" />;
}

export default function MarkdownEditorToolbar({
  client,
  trailing,
}: {
  client: WorkbenchFilePanelClient | null;
  /** File actions shown at the toolbar's end. */
  trailing?: ReactNode;
}) {
  const state = useSyncExternalStore(
    client?.subscribeToolbarState ?? noSubscription,
    client?.getToolbarState ?? disabledState,
    disabledState,
  );
  const mode = MODES[state.reviewMode];

  const commandButton = ({ command, icon, isActive }: ToolbarItem) => (
    <CommandTooltip command={command} key={command}>
      <IconButton
        label={EDITOR_COMMANDS[command].label}
        title=""
        size="small"
        display="hover-border"
        disabled={!state.editable}
        aria-pressed={isActive ? isActive(state) : undefined}
        className="aria-pressed:bg-fg/8"
        data-editor-command={command}
        onClick={() => client?.runCommand(command)}
      >
        {icon}
      </IconButton>
    </CommandTooltip>
  );

  return (
    <div
      role="toolbar"
      aria-label="Markdown formatting"
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none]"
      // Mouse presses keep focus and selection in the editor; touch presses record the selection to restore.
      onPointerDown={(event) => {
        if ((event.target as Element).closest("[data-editor-command]")) client?.beginToolbarInteraction(event.nativeEvent);
      }}
      onMouseDown={(event) => {
        if ((event.target as Element).closest("[data-editor-command]")) client?.beginToolbarInteraction(event.nativeEvent);
      }}
    >
      <PressDragMenu
        label={`${mode.label} mode. Click to switch, or drag to choose.`}
        heading="Editing mode"
        disabled={!state.editable}
        triggerAppearance="plain"
        triggerClassName={`
          inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[0.8rem] font-medium
          hover:bg-fg/5 disabled:opacity-45
          ${state.reviewMode === "suggest" ? "bg-accent-soft text-accent" : "text-fg/muted hover:text-text"}
        `}
        items={MODE_ORDER.map((id) => ({
          id,
          checked: id === state.reviewMode,
          content: (
            <span className="flex items-center gap-2.5">
              {MODES[id].icon}
              <span className="flex flex-col">
                <span className="font-medium">{MODES[id].label}</span>
                <span className="text-[0.78rem] text-fg/muted">{MODES[id].description}</span>
              </span>
            </span>
          ),
        }))}
        onActivate={() => client?.setReviewMode(state.reviewMode === "edit" ? "suggest" : "edit")}
        onSelect={(id) => {
          const next = MODE_ORDER.find((candidate) => candidate === id);
          if (next) client?.setReviewMode(next);
        }}
      >
        {mode.icon}
        <span>{mode.label}</span>
        <ChevronIcon aria-hidden="true" className="shrink-0 opacity-60" size={12} />
      </PressDragMenu>
      {GROUPS.map((group, index) => (
        <span className="flex shrink-0 items-center gap-0.5" key={index}>
          <ToolbarDivider />
          {group.map(commandButton)}
        </span>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        {commandButton({ command: "undo", icon: <Undo2Icon size={16} /> })}
        {commandButton({ command: "redo", icon: <Redo2Icon size={16} /> })}
        {trailing ? <><ToolbarDivider />{trailing}</> : null}
      </span>
    </div>
  );
}
