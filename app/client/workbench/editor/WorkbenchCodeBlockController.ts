/*
 * Exports:
 * - CodeBlockChrome: where one code block's header sits over the editor shell, and its language.
 * - CodeBlockChromeSnapshot: every code block's header and whether long lines wrap.
 * - WorkbenchCodeBlockControllerOptions: the editor, the shell the headers are placed in, and the mutation pipeline.
 * - WorkbenchCodeBlockController: code block header layout, language edits, copying and wrapping.
 * - default WorkbenchCodeBlockController: lay out a header over each code block's reserved top strip, outside the
 *   editable text, so its language, copy and wrap controls never become document content.
 */

import { readCodeBlockText } from "../dom/mutation/code-block-dom";

export interface CodeBlockChrome {
  id: string;
  language: string;
  left: number;
  top: number;
  width: number;
}

export interface CodeBlockChromeSnapshot {
  blocks: readonly CodeBlockChrome[];
  wrap: boolean;
}

export interface WorkbenchCodeBlockControllerOptions {
  container: HTMLElement;
  editor: HTMLElement;
  isRichMode: () => boolean;
  runStructuralMutation: (mutate: () => void) => void;
  scheduleFrame: (callback: () => void) => void;
}

export interface WorkbenchCodeBlockController {
  copy: (id: string) => Promise<boolean>;
  getSnapshot: () => CodeBlockChromeSnapshot;
  refresh: () => void;
  scheduleRefresh: () => void;
  setLanguage: (id: string, language: string) => void;
  setWrap: (wrap: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

const WRAP_ATTRIBUTE = "data-code-wrap";

function WorkbenchCodeBlockController(options: WorkbenchCodeBlockControllerOptions): WorkbenchCodeBlockController {
  const { container, editor } = options;
  const ids = new WeakMap<HTMLPreElement, string>();
  const listeners = new Set<() => void>();
  let nextId = 0;
  let snapshot: CodeBlockChromeSnapshot = { blocks: [], wrap: false };
  let snapshotKey = "";

  function idOf(pre: HTMLPreElement) {
    let id = ids.get(pre);
    if (!id) {
      nextId += 1;
      id = `code-${nextId}`;
      ids.set(pre, id);
    }
    return id;
  }

  function find(id: string) {
    return Array.from(editor.querySelectorAll("pre")).find((pre) => ids.get(pre) === id) ?? null;
  }

  function publish(next: CodeBlockChromeSnapshot) {
    const key = JSON.stringify(next);
    if (key === snapshotKey) return;
    snapshotKey = key;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function refresh() {
    const wrap = editor.hasAttribute(WRAP_ATTRIBUTE);
    if (!options.isRichMode()) {
      publish({ blocks: [], wrap });
      return;
    }
    const origin = container.getBoundingClientRect();
    const blocks = Array.from(editor.querySelectorAll("pre")).flatMap((pre): CodeBlockChrome[] => {
      const rect = pre.getBoundingClientRect();
      if (!rect.width && !rect.height) return [];
      return [{
        id: idOf(pre),
        language: pre.dataset.language ?? "",
        left: Math.round(rect.left - origin.left),
        top: Math.round(rect.top - origin.top),
        width: Math.round(rect.width),
      }];
    });
    publish({ blocks, wrap });
  }

  function setLanguage(id: string, language: string) {
    const pre = find(id);
    const next = language.replace(/[`\r\n]+/gu, "").trim();
    if (!pre || (pre.dataset.language ?? "") === next) return;
    options.runStructuralMutation(() => {
      if (next) pre.dataset.language = next;
      else delete pre.dataset.language;
    });
  }

  async function copy(id: string) {
    const pre = find(id);
    if (!pre) return false;
    try {
      await navigator.clipboard.writeText(readCodeBlockText(pre));
      return true;
    } catch {
      return false;
    }
  }

  function setWrap(wrap: boolean) {
    editor.toggleAttribute(WRAP_ATTRIBUTE, wrap);
    refresh();
  }

  return {
    copy,
    getSnapshot: () => snapshot,
    refresh,
    scheduleRefresh: () => options.scheduleFrame(refresh),
    setLanguage,
    setWrap,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export default WorkbenchCodeBlockController;
