/*
 * Exports:
 * - default MarkdownTableChrome: the controls around editor tables: add-column and add-row buttons on the active
 *   table's right and bottom edges, and the cell context menu inserting and deleting rows and columns.
 */
"use client";

import { useContext, useEffect, useSyncExternalStore } from "react";
import { EDITOR_COMMANDS, type EditorCommand } from "../../../workbench/editor/editor-commands";
import type { TableChromeSnapshot } from "../../../workbench/editor/WorkbenchTableController";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import Tooltip from "../../ui/Tooltip";
import WorkbenchContextMenuContext, { type WorkbenchContextMenuItem } from "../WorkbenchContextMenuContext";
import { PlusIcon } from "../workbench-icons";

const EMPTY_SNAPSHOT: TableChromeSnapshot = { activeId: null, tables: [] };
const BUTTON_PX = 24;
const EDGE_GAP_PX = 6;
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;
const INSERTS: readonly EditorCommand[] = ["row-above", "row-below", "column-left", "column-right"];

/** Edge buttons keep the editor's selection, like the toolbar's. */
function keepEditorFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

export default function MarkdownTableChrome({ client }: { client: WorkbenchFilePanelClient | null }) {
  const tables = client?.tables ?? null;
  const snapshot = useSyncExternalStore(tables?.subscribe ?? noSubscription, tables?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const contextMenu = useContext(WorkbenchContextMenuContext);

  useEffect(() => {
    if (!client || !contextMenu) return;
    const run = (command: EditorCommand) => () => client.runCommand(command);
    client.tables.setContextMenuHandler(({ canDeleteRow, x, y }) => {
      const items: WorkbenchContextMenuItem[] = [
        ...INSERTS.map((command) => ({ id: command, label: EDITOR_COMMANDS[command].label, onSelect: run(command) })),
        { id: "deletes", kind: "separator" },
        { disabled: !canDeleteRow, id: "delete-row", label: EDITOR_COMMANDS["delete-row"].label, onSelect: run("delete-row"), tone: "danger" },
        { id: "delete-column", label: EDITOR_COMMANDS["delete-column"].label, onSelect: run("delete-column"), tone: "danger" },
      ];
      contextMenu.openContextMenu({ menu: { id: "editor-table-cell", items, label: "Table" }, x, y });
    });
    return () => client.tables.setContextMenuHandler(null);
  }, [client, contextMenu]);

  const active = snapshot.tables.find((table) => table.id === snapshot.activeId);
  if (!tables || !active) return null;

  const edgeButton = (label: string, left: number, top: number, onClick: () => void) => (
    <Tooltip placement="top" delayMs={350} content={label}>
      <IconButton
        type="button"
        label={label}
        title=""
        display="hover-border"
        size="compact"
        className="pointer-events-auto absolute bg-[var(--app-bg-solid)]"
        style={{ left, top }}
        onMouseDown={keepEditorFocus}
        onClick={onClick}
      >
        <PlusIcon size={14} />
      </IconButton>
    </Tooltip>
  );

  return (
    <div aria-label="Table controls" className="pointer-events-none absolute inset-0 z-[5]">
      {edgeButton("Add column", active.left + active.width + EDGE_GAP_PX, active.top + active.height / 2 - BUTTON_PX / 2,
        () => tables.appendColumn(active.id))}
      {edgeButton("Add row", active.left + active.width / 2 - BUTTON_PX / 2, active.top + active.height + EDGE_GAP_PX / 2,
        () => tables.appendRow(active.id))}
    </div>
  );
}
