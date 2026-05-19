/*
 * Exports:
 * - WorkbenchRichInputControllerOptions: injected editor element and mode access for rich-input transforms without coordinator ownership. Keywords: workbench, rich input, controller, options, mode.
 * - WorkbenchRichInputResult: structural rich-input transform result for markdown shortcut interception. Keywords: workbench, rich input, result, heading, list item, comment.
 * - WorkbenchRichInputController: public event handler surface for rich-editor input transforms. Keywords: workbench, rich input, controller, handle.
 * - default WorkbenchRichInputController: bind editor-owned rich-input transformer registry for markdown shortcuts. Keywords: workbench, rich input, controller, heading, list item, block comment, default export.
 */

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

  return {
    handleRichInput,
  };
}

export default WorkbenchRichInputController;
