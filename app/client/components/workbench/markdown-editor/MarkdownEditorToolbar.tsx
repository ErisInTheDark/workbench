/*
 * Exports:
 * - default MarkdownEditorToolbar: the markdown editor's persistent toolbar: edit/suggest mode, formatting, code blocks,
 *   tables, comments, the markdown source toggle and history, acting on the editor selection without taking it.
 * - CommandTooltip: an editor command's label and this platform's keybind chip, for buttons outside the toolbar too.
 */
"use client";

import { useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { describeKeybind, EDITOR_COMMANDS, shownKeybind, type EditorCommand } from "../../../workbench/editor/editor-commands";
import type { ReviewMode } from "../../../workbench/editor/WorkbenchSuggestionController";
import type { EditorToolbarState } from "../../../workbench/WorkbenchEditorClient";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import Keybind, { isApplePlatform } from "../../ui/Keybind";
import RotatorButton, { type RotatorOption } from "../../ui/RotatorButton";
import Tooltip from "../../ui/Tooltip";
import {
  BoldIcon,
  CodeIcon,
  DiffIcon,
  FileCodeCornerIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  FeatherIcon,
  MessageSquareTextIcon,
  SparklesIcon,
  SquareCodeIcon,
  Redo2Icon,
  RemoveFormattingIcon,
  TableIcon,
  TextQuoteIcon,
  Undo2Icon,
} from "../workbench-icons";

const DISABLED_STATE: EditorToolbarState = {
  block: null,
  canEditSource: false,
  editable: false,
  inline: { bold: false, code: false, del: false, ins: false, italic: false },
  reviewMode: "edit",
  showGitMarkers: true,
  source: false,
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
    { command: "clear-format", icon: <RemoveFormattingIcon size={16} /> },
  ],
  [
    { command: "h1", icon: <Heading1Icon size={16} />, isActive: (state) => state.block === "h1" },
    { command: "h2", icon: <Heading2Icon size={16} />, isActive: (state) => state.block === "h2" },
    { command: "h3", icon: <Heading3Icon size={16} />, isActive: (state) => state.block === "h3" },
    { command: "quote", icon: <TextQuoteIcon size={16} />, isActive: (state) => state.block === "blockquote" },
    { command: "unordered-list", icon: <ListIcon size={16} />, isActive: (state) => state.block === "ul" },
    { command: "ordered-list", icon: <ListOrderedIcon size={16} />, isActive: (state) => state.block === "ol" },
    { command: "code-block", icon: <SquareCodeIcon size={16} />, isActive: (state) => state.block === "code" },
    { command: "table", icon: <TableIcon size={16} />, isActive: (state) => state.block === "table" },
  ],
  [
    { command: "comment", icon: <MessageSquareTextIcon size={16} /> },
  ],
];

const MODE_OPTIONS: readonly RotatorOption<ReviewMode>[] = [
  { icon: <FeatherIcon size={16} />, label: "Edit", value: "edit" },
  { icon: <SparklesIcon size={16} />, label: "Suggest", value: "suggest" },
];

/** A command's label with the keybind chip this platform shows for it. */
export function CommandTooltip({ children, command }: { children: ComponentProps<typeof Tooltip>["children"]; command: EditorCommand }) {
  const { label } = EDITOR_COMMANDS[command];
  const keybind = shownKeybind(command, isApplePlatform());
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
  className = "",
  client,
  trailing,
}: {
  /** Start and end padding live inside the scroller, so a toolbar spanning the screen never cuts controls off at its edges. */
  className?: string;
  client: WorkbenchFilePanelClient | null;
  /** File actions shown at the toolbar's end. */
  trailing?: ReactNode;
}) {
  const state = useSyncExternalStore(
    client?.subscribeToolbarState ?? noSubscription,
    client?.getToolbarState ?? disabledState,
    disabledState,
  );

  const commandButton = ({ command, disabled = false, icon, isActive }: ToolbarItem & { disabled?: boolean }) => (
    <CommandTooltip command={command} key={command}>
      <IconButton
        label={EDITOR_COMMANDS[command].label}
        title=""
        size="small"
        display="hover-border"
        disabled={!state.editable || disabled}
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
      className={`flex min-w-0 items-center gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none] ${className}`}
      // Mouse presses keep focus and selection in the editor; touch presses record the selection to restore.
      onPointerDown={(event) => {
        if ((event.target as Element).closest("[data-editor-command]")) client?.beginToolbarInteraction(event.nativeEvent);
      }}
      onMouseDown={(event) => {
        if ((event.target as Element).closest("[data-editor-command]")) client?.beginToolbarInteraction(event.nativeEvent);
      }}
    >
      <RotatorButton
        ariaLabel="Editing mode"
        disabled={!state.editable}
        className={`h-8 py-0 text-[0.8rem] ${state.reviewMode === "suggest" ? "text-accent" : ""}`}
        options={MODE_OPTIONS}
        value={state.reviewMode}
        onChange={(next) => client?.setReviewMode(next)}
      />
      {GROUPS.map((group, index) => (
        <span className="flex shrink-0 items-center gap-0.5" key={index}>
          <ToolbarDivider />
          {group.map(commandButton)}
        </span>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        {commandButton({ command: "source", disabled: !state.canEditSource, icon: <FileCodeCornerIcon size={16} />, isActive: (current) => current.source })}
        <Tooltip placement="bottom" delayMs={350} content={state.showGitMarkers ? "Hide git change markers" : "Show git change markers"}>
          <IconButton
            label="Git change markers"
            title=""
            size="small"
            display="hover-border"
            aria-pressed={state.showGitMarkers}
            className="aria-pressed:bg-fg/8"
            onClick={() => client?.setShowGitMarkers(!state.showGitMarkers)}
          >
            <DiffIcon size={16} />
          </IconButton>
        </Tooltip>
        <ToolbarDivider />
        {commandButton({ command: "undo", icon: <Undo2Icon size={16} /> })}
        {commandButton({ command: "redo", icon: <Redo2Icon size={16} /> })}
        {trailing ? <><ToolbarDivider />{trailing}</> : null}
      </span>
    </div>
  );
}
