/*
 * Exports:
 * - SVG_SOURCE_INDEX_ATTRIBUTE: preview attribute naming each element's source index.
 * - SvgViewBox: user-space rectangle the preview frames.
 * - readSvgViewBox: viewBox from the root, falling back to numeric width/height, then the SVG default size.
 * - buildSvgPreview: inert DOM copy of a parsed document, without scripts, foreign content, handlers or javascript: values.
 * - svgPreviewDataUrl: standalone image URL of a preview at a pixel size and currentColor.
 */
import { getSvgAttribute, type SvgSourceElement } from "./svg-source";

export const SVG_SOURCE_INDEX_ATTRIBUTE = "data-wb-svg-index";

export interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ATTRIBUTE_NAMESPACES: Record<string, string> = {
  xlink: "http://www.w3.org/1999/xlink",
  xml: "http://www.w3.org/XML/1998/namespace",
};
const BLOCKED_ELEMENTS = new Set(["script", "foreignObject", "iframe", "object", "embed"]);
const UNSAFE_VALUE = /javascript:|data:text\/html/iu;
const DEFAULT_VIEW_BOX: SvgViewBox = { x: 0, y: 0, width: 300, height: 150 };

function localName(name: string) {
  return name.slice(name.indexOf(":") + 1);
}

export function readSvgViewBox(root: SvgSourceElement): SvgViewBox {
  const values = (getSvgAttribute(root, "viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  if (values.length === 4 && values.every(Number.isFinite) && values[2]! > 0 && values[3]! > 0) {
    return { x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! };
  }
  const width = Number.parseFloat(getSvgAttribute(root, "width") ?? "");
  const height = Number.parseFloat(getSvgAttribute(root, "height") ?? "");
  return width > 0 && height > 0 ? { x: 0, y: 0, width, height } : DEFAULT_VIEW_BOX;
}

function isAllowedAttribute(element: string, name: string, value: string) {
  const lowered = name.toLowerCase();
  if (lowered.startsWith("on") || lowered === "xmlns" || lowered.startsWith("xmlns:")) return false;
  if (UNSAFE_VALUE.test(value)) return false;
  return !(localName(element) === "a" && (lowered === "href" || lowered === "xlink:href"));
}

function buildElement(document: Document, source: SvgSourceElement): Element | null {
  if (BLOCKED_ELEMENTS.has(localName(source.name))) return null;
  let element: Element;
  try {
    element = document.createElementNS(SVG_NAMESPACE, source.name);
  } catch {
    return null;
  }
  for (const attribute of source.attributes) {
    if (!isAllowedAttribute(source.name, attribute.name, attribute.value)) continue;
    const prefix = attribute.name.includes(":") ? attribute.name.slice(0, attribute.name.indexOf(":")) : "";
    const namespace = ATTRIBUTE_NAMESPACES[prefix];
    try {
      if (namespace) element.setAttributeNS(namespace, attribute.name, attribute.value);
      else element.setAttribute(attribute.name, attribute.value);
    } catch {
      // Names the DOM rejects cannot render either way; the source still keeps them.
    }
  }
  element.setAttribute(SVG_SOURCE_INDEX_ATTRIBUTE, String(source.index));
  for (const child of source.children) {
    if (child.kind === "element") {
      const built = buildElement(document, child.element);
      if (built) element.append(built);
    } else if (child.kind === "text" || child.kind === "cdata") {
      element.append(document.createTextNode(child.text));
    }
  }
  return element;
}

export function buildSvgPreview(document: Document, root: SvgSourceElement): SVGSVGElement {
  const element = buildElement(document, root) as SVGSVGElement;
  const viewBox = readSvgViewBox(root);
  element.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  element.setAttribute("width", "100%");
  element.setAttribute("height", "100%");
  return element;
}

export function svgPreviewDataUrl(preview: SVGSVGElement, size: number, color: string) {
  const copy = preview.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(size));
  copy.setAttribute("height", String(size));
  copy.style.color = color;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
}
