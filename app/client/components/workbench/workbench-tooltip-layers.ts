/*
 * Exports:
 * - WorkbenchTooltipNode: one open tooltip's place among layers and nested triggers.
 * - WorkbenchTooltipLayers: own which tooltips are open, per-layer root exclusivity, cascading closes, and the pointer safe-area chain.
 * - workbenchTooltipLayers: the registry shared by every tooltip in the document.
 *
 * A tooltip whose trigger sits inside another tooltip's trigger is a nested child: it joins its parent's panel on the
 * same layer. A tooltip whose trigger sits inside another tooltip's content is owned by it and opens one layer higher.
 */

export interface WorkbenchTooltipNode {
  id: symbol;
  layer: number;
  /** The tooltip whose content holds this trigger, one layer below. */
  owner: symbol | null;
  /** The tooltip whose trigger holds this trigger, on the same layer. */
  parent: symbol | null;
}

interface OpenTooltip extends WorkbenchTooltipNode {
  close: () => void;
  isPointerLocallySafe: (x: number, y: number) => boolean;
}

export class WorkbenchTooltipLayers {
  #open = new Map<symbol, OpenTooltip>();

  isOpen(id: symbol) {
    return this.#open.has(id);
  }

  /** Opening a root closes every other root on its layer, and with them everything they hold open. */
  open(node: WorkbenchTooltipNode, ports: Pick<OpenTooltip, "close" | "isPointerLocallySafe">) {
    if (node.parent === null) {
      for (const other of [...this.#open.values()]) {
        if (other.id !== node.id && other.layer === node.layer && other.parent === null && this.#open.has(other.id)) this.close(other.id);
      }
    }
    this.#open.set(node.id, { ...node, ...ports });
  }

  /** Closing a tooltip closes its nested children and every higher layer it owns. */
  close(id: symbol) {
    const tooltip = this.#open.get(id);
    if (!tooltip) return;
    this.#open.delete(id);
    for (const child of this.#children(id)) this.close(child.id);
    tooltip.close();
  }

  /** The pointer may rest on this tooltip's own area or on anything it holds open. */
  isPointerSafe(id: symbol, x: number, y: number): boolean {
    const tooltip = this.#open.get(id);
    if (!tooltip) return false;
    return tooltip.isPointerLocallySafe(x, y) || this.#children(id).some((child) => this.isPointerSafe(child.id, x, y));
  }

  #children(id: symbol) {
    return [...this.#open.values()].filter((tooltip) => tooltip.parent === id || tooltip.owner === id);
  }
}

export const workbenchTooltipLayers = new WorkbenchTooltipLayers();
