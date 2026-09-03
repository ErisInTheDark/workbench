/*
 * Exports:
 * - WorkbenchRichInputControllerOptions: injected editor element and mode access for rich-input transforms without coordinator ownership. Keywords: workbench, rich input, controller, options, mode.
 * - WorkbenchRichInputResult: structural rich-input transform result for markdown shortcut interception. Keywords: workbench, rich input, result, heading, list item, comment.
 * - WorkbenchRichInputController: public event handler surface for rich-editor input transforms. Keywords: workbench, rich input, controller, handle.
 * - default WorkbenchRichInputController: bind editor-owned rich-input transformer and block-normalizer registries for markdown shortcuts and pasted markdown blocks. Keywords: workbench, rich input, controller, heading, list item, block comment, paste, default export.
 */

import {
    normalizeRichInputBlocksOutsideSelection,
    type RichInputBlockNormalizationResult,
} from "./rich-input-block-normalizers";
import {
    runRichInputTransformers,
    type RichInputTransformResult,
} from "./rich-input-transformers";

export interface WorkbenchRichInputControllerOptions {
  editor: HTMLElement;
  getMode: () => "rich" | "plain";
}

export type WorkbenchRichInputResult = RichInputTransformResult;

interface WorkbenchRichInputController {
  handleRichInput: (event: Event) => WorkbenchRichInputResult;
  normalizeBlocksOutsideSelection: () => RichInputBlockNormalizationResult;
}

function WorkbenchRichInputController(
  options: WorkbenchRichInputControllerOptions,
): WorkbenchRichInputController {
  const { editor, getMode } = options;

  function handleRichInput(event: Event): WorkbenchRichInputResult {
    if (!(event instanceof InputEvent)) {
      return {
        transformedListItem: null,
        transformedBlock: null,
        commentCaretMarker: null,
      };
    }

    return runRichInputTransformers(event, { editor, getMode }) satisfies RichInputTransformResult;
  }

  function normalizeBlocksOutsideSelection() {
    if (getMode() !== "rich") {
      return { normalizedBlockCount: 0 };
    }

    return normalizeRichInputBlocksOutsideSelection(editor);
  }

  return {
    handleRichInput,
    normalizeBlocksOutsideSelection,
  };
}

export default WorkbenchRichInputController;
