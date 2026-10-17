/*
 * Exports:
 * - SaveBlockedError: thrown when the real save button is pressed but the save guard refuses to write.
 * - KeyModifiers: modifier keys for simulated key presses.
 * - default MountedFilePanel: mount the real file panel client in jsdom over fake disk, drive it with browser-shaped events
 *   and toolbar commands, resolve suggestions, and prove saves reach disk.
 */
import { flushAnimationFrames } from "./jsdom-environment";

import type { SaveConflictPayload, SaveFilePayload } from "workbench-shared/types";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { FileDocumentSnapshot, WorkbenchFileDocument } from "../file/WorkbenchFileStore";
import type { EditorCommand } from "../editor/editor-commands";
import { REVIEW_ATTRIBUTES } from "../markdown/review-markup";
import FileDraftStore from "../state/FileDraftStore";
import WorkbenchFilePanelClient from "../WorkbenchFilePanelClient";
import type { WorkbenchEditorDomSurfaces } from "../workbench-dom";

export class SaveBlockedError extends Error {}

interface SaveGuardReport {
  markdown: string;
  currentMarkupExcerpt: string;
  roundTripMarkupExcerpt: string;
}

export interface KeyModifiers {
  alt?: boolean;
  ctrl?: boolean;
  shift?: boolean;
}

const PROJECT_ID = ProjectIdSchema.parse("project");
const DAEMON_ID = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const BLOCK_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE|LI|PRE|SUMMARY)$/u;

/** Disk double: one file whose writes always succeed and are recorded. */
class FakeDisk implements WorkbenchFileDocument {
  readonly location = { daemonId: DAEMON_ID, projectId: PROJECT_ID };
  readonly drafts = FileDraftStore(() => PROJECT_ID);
  readonly writes: string[] = [];
  private snapshot: FileDocumentSnapshot;
  private mtimeMs = 1;
  private readonly listeners = new Set<() => void>();

  constructor(readonly path: string, private content: string) {
    this.snapshot = this.current();
  }

  getSnapshot() { return this.snapshot; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read() { return this.payload(); }

  async save(content: string): Promise<SaveFilePayload | SaveConflictPayload> {
    this.writes.push(content);
    this.content = content;
    this.mtimeMs += 1;
    this.snapshot = this.current();
    return { projectId: PROJECT_ID, path: this.path, mtimeMs: this.mtimeMs, updatedAt: new Date(this.mtimeMs).toISOString(), changes: {} };
  }

  async reset(): Promise<SaveFilePayload | SaveConflictPayload> {
    return { projectId: PROJECT_ID, path: this.path, mtimeMs: this.mtimeMs, updatedAt: new Date(this.mtimeMs).toISOString(), changes: {} };
  }

  private payload() {
    return { content: this.content, headContent: null, mtimeMs: this.mtimeMs, path: this.path, projectId: PROJECT_ID,
      updatedAt: new Date(this.mtimeMs).toISOString() };
  }

  private current(): FileDocumentSnapshot {
    return { phase: "current", failure: null, data: { ...this.payload(), changeSummary: null } };
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement) {
  const child = document.createElement(tag);
  parent.append(child);
  return child;
}

function createSurfaces(host: HTMLElement): WorkbenchEditorDomSurfaces {
  const dialog = () => Object.assign(element("div", host), { hidden: true });
  const button = () => element("button", host);
  const text = () => element("p", host);
  return {
    controls: { resetDraftButton: button(), saveFileButton: button() },
    dialogs: {
      resetDraft: { cancel: button(), dialog: dialog(), resetToHead: button(), resetToSaved: button() },
      saveConflict: { actual: text(), dialog: dialog(), expected: text(), keepEditing: button(), overwrite: button(), reload: button(), summary: text() },
    },
    editor: { customCaret: element("div", host), diffGutter: element("div", host), editor: element("div", host), reviewLayer: element("div", host) },
    statusDisplay: { filePathLabel: text(), statusLine: text() },
    toolbars: { revisionAccept: button(), revisionHover: element("div", host), revisionReject: button() },
  };
}

function nextImmediate() {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

/**
 * Drain jsdom's queued tasks (selectionchange dispatch uses setImmediate). Interaction steps also run the animation frames
 * they scheduled (editor chrome) and those frames' follow-ups; sweeps skip chrome, which never touches content.
 */
async function settle({ frames = false }: { frames?: boolean } = {}) {
  await nextImmediate();
  if (!frames) return;
  flushAnimationFrames();
  await nextImmediate();
}

function textNodesIn(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function closestBlock(node: Node, editor: HTMLElement) {
  for (let current: Node | null = node; current && current !== editor; current = current.parentNode) {
    if (current instanceof HTMLElement && BLOCK_TAGS.test(current.tagName)) return current;
  }
  return null;
}

/** Deepest text node at one edge of an inline subtree; blocks, breaks and hidden markers stop the walk. */
function edgeText(node: Node | undefined, edge: "first" | "last"): Text | null {
  if (node instanceof Text) return node;
  if (!(node instanceof HTMLElement) || node.hidden || node instanceof HTMLBRElement || BLOCK_TAGS.test(node.tagName)) return null;
  return edgeText((edge === "first" ? node.firstChild : node.lastChild) ?? undefined, edge);
}

function isWhitespace(character: string | undefined) {
  return character === " " || character === " ";
}

export default class MountedFilePanel {
  readonly editor: HTMLDivElement;
  private readonly host: HTMLElement;
  private readonly surfaces: WorkbenchEditorDomSurfaces;
  private readonly client: ReturnType<typeof WorkbenchFilePanelClient>;

  private readonly guardReports: SaveGuardReport[] = [];
  private readonly restoreWarn: () => void;

  private constructor(readonly disk: FakeDisk) {
    // Save-guard warnings are expected evidence here; collect them for failure messages instead of letting them reach output.
    const warn = console.warn;
    console.warn = (...values: unknown[]) => {
      const metadata = values[1];
      if (typeof metadata === "object" && metadata && "currentMarkupExcerpt" in metadata) this.guardReports.push(metadata as SaveGuardReport);
    };
    this.restoreWarn = () => { console.warn = warn; };
    this.host = element("div", document.body);
    this.surfaces = createSurfaces(this.host);
    this.editor = this.surfaces.editor.editor;
    this.client = WorkbenchFilePanelClient({ document: disk, surfaces: this.surfaces });
    this.client.acceptObservation(disk.getSnapshot());
  }

  static async open(markdown: string, path = "notes.md") {
    const panel = new MountedFilePanel(new FakeDisk(path, markdown));
    await settle();
    return panel;
  }

  dispose() {
    window.getSelection()?.removeAllRanges();
    this.client.dispose();
    this.host.remove();
    this.restoreWarn();
  }

  /**
   * Editor DOM with one top-level node per line, so goldens stay reviewable. Preserved-source bookkeeping is left out
   * and suggestion ids are numbered by appearance, since only which blocks share one matters.
   */
  get html() {
    const suggestionIds = new Map<string, string>();
    return Array.from(this.editor.childNodes, node => {
      if (!(node instanceof Element)) return node.textContent ?? "";
      const copy = node.cloneNode(true) as Element;
      for (const attribute of [REVIEW_ATTRIBUTES.source, REVIEW_ATTRIBUTES.sourceTight]) copy.removeAttribute(attribute);
      const id = copy.getAttribute(REVIEW_ATTRIBUTES.suggestion);
      if (id !== null) {
        if (!suggestionIds.has(id)) suggestionIds.set(id, `s${suggestionIds.size + 1}`);
        copy.setAttribute(REVIEW_ATTRIBUTES.suggestion, suggestionIds.get(id)!);
      }
      return copy.outerHTML;
    }).join("\n");
  }

  /** Press the real save button; resolve with the markdown that reached disk or throw with the save-guard report. */
  async save() {
    const before = this.disk.writes.length;
    this.guardReports.length = 0;
    this.surfaces.controls.saveFileButton.click();
    await settle();
    if (this.disk.writes.length === before) {
      const report = this.guardReports.at(-1);
      throw new SaveBlockedError([
        "save blocked",
        `markdown:  ${JSON.stringify(report?.markdown ?? null)}`,
        `current:   ${report?.currentMarkupExcerpt ?? "(no save-guard report)"}`,
        `roundtrip: ${report?.roundTripMarkupExcerpt ?? ""}`,
        `editor:    ${this.html}`,
      ].join("\n"));
    }
    return this.disk.writes.at(-1)!;
  }

  /** Replace editor DOM the way paste or devtools would, then let the editor's input pipeline react. */
  async replaceHtml(html: string, inputType = "insertFromPaste") {
    this.focus();
    this.editor.innerHTML = html;
    this.clearSelection();
    this.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
    await settle();
  }

  /** Fire a bare input event, as after a browser edit the editor did not intercept, without changing DOM. */
  async notifyInput(inputType = "insertText") {
    this.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
    await settle();
  }

  focus() {
    if (document.activeElement === this.editor) return;
    this.editor.focus();
    if (document.activeElement !== this.editor) this.editor.dispatchEvent(new FocusEvent("focus"));
  }

  clearSelection() {
    window.getSelection()?.removeAllRanges();
  }

  /** Place a collapsed caret where `|` sits in `needle`; at a text-node boundary it joins the side the needle names. */
  async caret(needle: string, occurrence = 0) {
    const index = needle.indexOf("|");
    if (index < 0) throw new Error(`caret needle needs "|": ${needle}`);
    const start = this.findText(needle.replace("|", ""), occurrence) + index;
    const point = this.pointAt(start, index === 0 ? "after" : "before");
    this.setRange(point, point);
    await settle({ frames: true });
  }

  /** Select the `[...]` span of `needle`. */
  async select(needle: string, occurrence = 0) {
    const open = needle.indexOf("[");
    const close = needle.indexOf("]");
    if (open < 0 || close < open) throw new Error(`selection needle needs "[...]": ${needle}`);
    const plain = needle.replace("[", "").replace("]", "");
    const base = this.findText(plain, occurrence);
    this.setRange(this.pointAt(base + open, "after"), this.pointAt(base + close - 1));
    await settle({ frames: true });
  }

  async caretIn(node: Node, offset: number) {
    this.setRange({ node, offset }, { node, offset });
    await settle();
  }

  /** Press a toolbar button the way the persistent toolbar does: a mouse press that keeps the selection, then the command. */
  async toolbar(command: EditorCommand) {
    this.client.beginToolbarInteraction(new MouseEvent("mousedown", { cancelable: true }));
    this.client.runCommand(command);
    await settle({ frames: true });
  }

  /** The caret's block text with `|` where a collapsed caret sits, or null without one in the editor. */
  get caretText() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const block = closestBlock(range.startContainer, this.editor);
    if (!block) return null;
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const text = block.textContent ?? "";
    const offset = before.toString().length;
    return `${text.slice(0, offset)}|${text.slice(offset)}`;
  }

  /** The panel client the React toolbar and comment margin drive. */
  get panel() {
    return this.client;
  }

  /** Keep one side of the first suggestion row through its header button. */
  async resolveSuggestion(action: "accept" | "reject") {
    await settle({ frames: true });
    const button = this.surfaces.editor.reviewLayer.querySelector<HTMLButtonElement>(`[data-suggestion-action="${action}"]`);
    if (!button) throw new Error(`no suggestion row to ${action}`);
    button.click();
    await settle({ frames: true });
  }

  /** Type text one character at a time through beforeinput, browser default insertion, and input. */
  async type(text: string) {
    for (const character of text) {
      if (character === "\n") {
        await this.press("Enter");
        continue;
      }
      await this.input("insertText", character, () => this.insertCharacter(character));
    }
  }

  async press(key: string, modifiers: KeyModifiers = {}) {
    this.focus();
    const keydown = new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key, code: key === "`" ? "Backquote" : `Key${key.toUpperCase()}`,
      ctrlKey: modifiers.ctrl ?? false, shiftKey: modifiers.shift ?? false, altKey: modifiers.alt ?? false,
    });
    this.editor.dispatchEvent(keydown);
    if (keydown.defaultPrevented || modifiers.ctrl || modifiers.alt) {
      await settle({ frames: true });
      return;
    }
    if (key === "Enter") {
      await (modifiers.shift
        ? this.input("insertLineBreak", null, () => this.insertLineBreak())
        : this.input("insertParagraph", null, () => this.splitBlock()));
    } else if (key === "Backspace") {
      await this.input("deleteContentBackward", null, () => this.deleteBackward());
    } else {
      await settle({ frames: true });
    }
  }

  private async input(inputType: string, data: string | null, applyDefault: () => void) {
    this.focus();
    const beforeInput = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
    this.editor.dispatchEvent(beforeInput);
    if (!beforeInput.defaultPrevented) {
      applyDefault();
      this.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
    }
    await settle({ frames: true });
  }

  private findText(plain: string, occurrence: number) {
    const text = textNodesIn(this.editor).map(node => node.data).join("");
    let index = -1;
    for (let seen = 0; seen <= occurrence; seen += 1) {
      index = text.indexOf(plain, index + 1);
      if (index < 0) throw new Error(`text ${JSON.stringify(plain)} #${occurrence} not in editor: ${JSON.stringify(text)}`);
    }
    return index;
  }

  private pointAt(offset: number, affinity: "before" | "after" = "before") {
    let remaining = offset;
    const nodes = textNodesIn(this.editor);
    for (const [index, node] of nodes.entries()) {
      const fits = affinity === "before" ? remaining <= node.length : remaining < node.length;
      if (fits || index === nodes.length - 1) return { node: node as Node, offset: Math.min(remaining, node.length) };
      remaining -= node.length;
    }
    return { node: this.editor as Node, offset: 0 };
  }

  private setRange(start: { node: Node; offset: number }, end: { node: Node; offset: number }) {
    this.focus();
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private range() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) throw new Error("no selection in editor");
    return selection.getRangeAt(0);
  }

  private collapseTo(node: Node, offset: number) {
    this.setRange({ node, offset }, { node, offset });
  }

  private insertCharacter(character: string) {
    const range = this.range();
    if (!range.collapsed) range.deleteContents();
    let { startContainer: container, startOffset: offset } = range;
    if (!(container instanceof Text)) {
      // Like Chrome, an element-position caret types into the nearest text leaf, preferring the one before it.
      const before = edgeText(container.childNodes[offset - 1], "last");
      const after = edgeText(container.childNodes[offset], "first");
      if (before) {
        container = before;
        offset = before.length;
      } else if (after) {
        container = after;
        offset = 0;
      } else {
        // A lone <br> only keeps an empty block open; browsers replace it with the first typed text.
        const placeholder = container.childNodes.length === 1 && container.firstChild instanceof HTMLBRElement ? container.firstChild : null;
        const node = document.createTextNode("");
        container.insertBefore(node, container.childNodes[offset] ?? null);
        placeholder?.remove();
        container = node;
        offset = 0;
      }
    }
    const text = container as Text;
    // Chrome keeps editable whitespace visible: spaces at text ends or beside whitespace become nbsp, and an nbsp after a word reverts once text follows.
    let inserted = character;
    if (character === " " && (offset === text.length || offset === 0 || isWhitespace(text.data[offset - 1]) || isWhitespace(text.data[offset]))) {
      inserted = " ";
    } else if (character !== " " && text.data[offset - 1] === " " && offset > 1 && !isWhitespace(text.data[offset - 2])) {
      text.replaceData(offset - 1, 1, " ");
    }
    text.insertData(offset, inserted);
    this.collapseTo(text, offset + inserted.length);
  }

  private insertLineBreak() {
    const range = this.range();
    if (!range.collapsed) range.deleteContents();
    const lineBreak = document.createElement("br");
    range.insertNode(lineBreak);
    const parent = lineBreak.parentNode!;
    if (!lineBreak.nextSibling || (lineBreak.nextSibling instanceof Text && !lineBreak.nextSibling.data)) {
      parent.insertBefore(document.createElement("br"), lineBreak.nextSibling);
    }
    this.collapseTo(parent, Array.from(parent.childNodes).indexOf(lineBreak) + 1);
  }

  private splitBlock() {
    const range = this.range();
    if (!range.collapsed) range.deleteContents();
    const block = closestBlock(range.startContainer, this.editor);
    if (!block) return;
    const tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(block, block.childNodes.length);
    const fragment = tail.extractContents();
    const emptyTail = !fragment.textContent;
    const tag = /^H[1-6]$/u.test(block.tagName) && emptyTail ? "p" : block.tagName.toLowerCase();
    const next = document.createElement(tag);
    if (emptyTail) next.append(document.createElement("br"));
    else next.append(fragment);
    if (!block.textContent && !block.querySelector("br")) block.append(document.createElement("br"));
    block.after(next);
    this.collapseTo(next, 0);
  }

  private deleteBackward() {
    const range = this.range();
    if (!range.collapsed) {
      range.deleteContents();
      return;
    }
    const { startContainer: container, startOffset: offset } = range;
    if (container instanceof Text && offset > 0) {
      container.deleteData(offset - 1, 1);
      const block = closestBlock(container, this.editor);
      if (block && !block.textContent && !block.querySelector("br")) block.append(document.createElement("br"));
      this.collapseTo(container, offset - 1);
      return;
    }
    const block = closestBlock(container, this.editor);
    const previous = block?.previousElementSibling;
    if (!block || !(previous instanceof HTMLElement)) return;
    const trailingBreak = previous.lastChild instanceof HTMLBRElement ? previous.lastChild : null;
    trailingBreak?.remove();
    const joinOffset = previous.childNodes.length;
    for (const child of Array.from(block.childNodes)) {
      if (!(child instanceof HTMLBRElement && block.childNodes.length === 1)) previous.append(child);
    }
    block.remove();
    this.collapseTo(previous, joinOffset);
  }
}
