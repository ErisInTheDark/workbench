/*
 * Exports:
 * - SAVE_GUARD_VERIFY_FLAG: global symbol that, when set (test environments), checks every inspection against the
 *   whole-document path.
 * - default SaveGuardInspector: one editor's save-guard inspection, reusing each unchanged top-level block's
 *   normalized signature and markdown so an edit re-reads only the blocks it touched.
 */

import { isRootBreakNode, hasMergeableSiblingLists } from "../dom/mutation/structured-block-dom";
import type { SaveGuardIssue } from "../WorkbenchEditorClient";
import { renderEditorMarkdownUnits } from "./markdown-html-render";
import {
    collectMarkdownTokens,
    createWorkbenchMarkupSignature,
    joinMarkdownTokens,
    type SerializedMarkdownToken,
} from "./markdown-serialization";
import type { MarkdownStyle } from "./markdown-style";
import { getCommentThreadKind, getSuggestionId, isCommentThreadElement, REVIEW_ATTRIBUTES } from "./review-markup";
import {
    createSaveGuardNormalizer,
    inspectSaveGuardMarkup,
    type InspectSaveGuardMarkupOptions,
} from "./save-guard-inspection";

export const SAVE_GUARD_VERIFY_FLAG = Symbol.for("workbench.saveGuard.verify");

interface NormalizedUnit {
  /** The unit's top-level nodes after save-guard normalization, detached. */
  nodes: readonly Node[];
  signature: string;
}

interface CurrentUnit extends NormalizedUnit {
  tokens: SerializedMarkdownToken[];
}

interface SaveGuardInspection {
  issue: SaveGuardIssue | null;
  markdown: string;
}

/** Blocks whose normalization only ever looks inside themselves; anything else at the root can merge into or split its neighbours. */
const SELF_CONTAINED_TAGS = /^(P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|HR|TABLE|BR)$/u;
const SUGGESTION_SELECTOR = `[${REVIEW_ATTRIBUTES.suggestion}]`;

function isSelfContainedUnitNode(node: Node) {
  if (!(node instanceof HTMLElement)) return false;
  if (getSuggestionId(node) !== null || node.querySelector(SUGGESTION_SELECTOR)) return false;
  if (isCommentThreadElement(node)) return getCommentThreadKind(node) === "block";
  return SELF_CONTAINED_TAGS.test(node.tagName);
}

function isIgnorableRootText(node: Node) {
  return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
}

/**
 * Root-level normalization that crosses blocks: lists merging over at most one break, and breaks dropped at the
 * document's edges. Where either could apply, only the whole document reads correctly.
 */
function blocksInteract(nodes: readonly Node[]) {
  return !nodes.length || isRootBreakNode(nodes[0]!) || isRootBreakNode(nodes.at(-1)!) || hasMergeableSiblingLists(nodes);
}

export default class SaveGuardInspector {
  readonly #options: InspectSaveGuardMarkupOptions;
  readonly #normalize: (root: ParentNode) => void;
  #styleKey = "";
  /** Keyed by a live top-level node's `outerHTML`; each inspection keeps only what it read. */
  #currentUnits = new Map<string, CurrentUnit>();
  /** Keyed by a rendered unit's html. */
  #roundTripUnits = new Map<string, NormalizedUnit>();

  constructor(options: Omit<InspectSaveGuardMarkupOptions, "renderMarkdown" | "serializeMarkdown" | "style">) {
    this.#options = options;
    this.#normalize = createSaveGuardNormalizer(options);
  }

  inspect(style: MarkdownStyle): SaveGuardInspection {
    const inspection = this.#inspectByBlock(style) ?? this.#inspectWholeDocument(style);
    if ((globalThis as Record<symbol, unknown>)[SAVE_GUARD_VERIFY_FLAG]) {
      const whole = this.#inspectWholeDocument(style);
      if (whole.markdown !== inspection.markdown || Boolean(whole.issue) !== Boolean(inspection.issue)) {
        throw new Error([
          "save-guard block inspection disagrees with the whole document",
          `blocks: ${JSON.stringify(inspection.markdown)} issue=${Boolean(inspection.issue)}`,
          `whole:  ${JSON.stringify(whole.markdown)} issue=${Boolean(whole.issue)}`,
        ].join("\n"));
      }
    }
    return inspection;
  }

  #inspectWholeDocument(style: MarkdownStyle) {
    return inspectSaveGuardMarkup({ ...this.#options, style });
  }

  #inspectByBlock(style: MarkdownStyle): SaveGuardInspection | null {
    const styleKey = JSON.stringify(style);
    if (styleKey !== this.#styleKey) {
      this.#styleKey = styleKey;
      this.#currentUnits.clear();
      this.#roundTripUnits.clear();
    }

    const current = this.#readCurrentUnits(style);
    if (!current) return null;
    const markdown = joinMarkdownTokens(current.flatMap((unit) => unit.tokens), style);

    const roundTrip = this.#readRoundTripUnits(markdown);
    if (!roundTrip) return null;

    const currentMarkup = current.map((unit) => unit.signature).join("");
    const roundTripMarkup = roundTrip.map((unit) => unit.signature).join("");
    return {
      issue: currentMarkup === roundTripMarkup ? null : { currentMarkup, markdown, roundTripMarkup },
      markdown,
    };
  }

  #readCurrentUnits(style: MarkdownStyle) {
    const used = new Map<string, CurrentUnit>();
    const units: CurrentUnit[] = [];
    for (const node of Array.from(this.#options.editorRoot.childNodes)) {
      if (isIgnorableRootText(node)) continue;
      if (!isSelfContainedUnitNode(node)) return null;
      const key = (node as HTMLElement).outerHTML;
      const unit = used.get(key) ?? this.#currentUnits.get(key) ?? this.#normalizeCurrentUnit(node, style);
      if (!unit) return null;
      used.set(key, unit);
      units.push(unit);
    }
    this.#currentUnits = used;
    return blocksInteract(units.flatMap((unit) => unit.nodes)) ? null : units;
  }

  #readRoundTripUnits(markdown: string) {
    const used = new Map<string, NormalizedUnit>();
    const units: NormalizedUnit[] = [];
    for (const html of renderEditorMarkdownUnits(markdown)) {
      const unit = used.get(html) ?? this.#roundTripUnits.get(html) ?? this.#normalizeRenderedUnit(html);
      if (!unit) return null;
      used.set(html, unit);
      units.push(unit);
    }
    this.#roundTripUnits = used;
    return blocksInteract(units.flatMap((unit) => unit.nodes)) ? null : units;
  }

  #normalizeCurrentUnit(node: Node, style: MarkdownStyle): CurrentUnit | null {
    const root = this.#normalizeUnit([node.cloneNode(true)]);
    if (!root) return null;
    const options = { isInlineRunContainer: this.#options.isInlineRunContainer, style };
    return {
      nodes: Array.from(root.childNodes),
      signature: createWorkbenchMarkupSignature(root, options),
      tokens: collectMarkdownTokens(Array.from(root.childNodes), options),
    };
  }

  #normalizeRenderedUnit(html: string): NormalizedUnit | null {
    const template = this.#options.editorRoot.ownerDocument.createElement("div");
    template.innerHTML = html;
    const nodes = Array.from(template.childNodes).filter((node) => !isIgnorableRootText(node));
    if (!nodes.every(isSelfContainedUnitNode)) return null;
    const root = this.#normalizeUnit(nodes);
    if (!root) return null;
    return {
      nodes: Array.from(root.childNodes),
      signature: createWorkbenchMarkupSignature(root, { isInlineRunContainer: this.#options.isInlineRunContainer }),
    };
  }

  /**
   * Normalize a unit between two rules, which no root pass merges with or trims, so it reads exactly as it does among
   * its neighbours in the whole document. Null when normalization left something that is not a self-contained block.
   */
  #normalizeUnit(nodes: readonly Node[]) {
    const document = this.#options.editorRoot.ownerDocument;
    const root = document.createElement("div");
    const before = document.createElement("hr");
    const after = document.createElement("hr");
    root.append(before, ...nodes, after);
    this.#normalize(root);
    if (before.parentNode !== root || after.parentNode !== root || root.firstChild !== before || root.lastChild !== after) {
      return null;
    }
    before.remove();
    after.remove();
    const normalized = Array.from(root.childNodes);
    return normalized.every((node) => isIgnorableRootText(node) || isSelfContainedUnitNode(node)) ? root : null;
  }
}
