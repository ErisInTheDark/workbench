/*
 * Exports:
 * - default WorkbenchSaveButton: the one save button both file editors end their toolbar with; it saves, or saves as
 *   while Shift is held (or on a Shift-click), and always saves as for an unsaved new file.
 */
"use client";

import IconButton from "../../ui/IconButton";
import { CommandTooltip } from "../markdown-editor/MarkdownEditorToolbar";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { SaveAsIcon, SaveIcon } from "../workbench-icons";

export default function WorkbenchSaveButton({
  invalid = false,
  onSave,
  onSaveAs,
  saveAsDisabled = false,
  saveAsOnly = false,
  saveDisabled = false,
  saving = false,
}: {
  /** The draft cannot be saved as it stands, such as markup the editor cannot write back. */
  invalid?: boolean;
  onSave: () => void;
  /** Absent where a copy cannot be opened in place of this file. */
  onSaveAs?: () => void;
  saveAsDisabled?: boolean;
  /** Nothing exists to save in place, as for an unsaved new file. */
  saveAsOnly?: boolean;
  saveDisabled?: boolean;
  saving?: boolean;
}) {
  // Toolbar presses keep focus in the editor, so Shift counts even while typing.
  const shiftHeld = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const saveAs = onSaveAs ? saveAsOnly || shiftHeld : false;
  return (
    <CommandTooltip command={saveAs ? "save-as" : "save"}>
      <IconButton
        type="button"
        title=""
        label={saveAs ? "Save as" : "Save current file"}
        size="small"
        display="hover-border"
        data-invalid={invalid ? "true" : "false"}
        disabled={saveAs ? saveAsDisabled : saveDisabled}
        pendingHalo={saving}
        onClick={(event) => {
          if (onSaveAs && (saveAs || event.shiftKey)) onSaveAs();
          else onSave();
        }}
      >
        {saveAs ? <SaveAsIcon size={16} /> : <SaveIcon size={16} />}
      </IconButton>
    </CommandTooltip>
  );
}
