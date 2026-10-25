/*
 * Exports:
 * - EXECUTABLE_HREF_SCHEME: schemes a link must never carry, since opening them runs code.
 * - toLinkDestination: typed link input as an href that is safe to open and reads back unchanged from markdown.
 * - LinkTarget: where opening an href leads: a web address, a file beside the document, or one of its headings.
 * - resolveLinkTarget: resolve an href against the path of the document holding it.
 * - headingSlug: the GitHub-style anchor of a heading's text.
 */

import { normalizeMarkdownHref } from "./markdown-links";

export const EXECUTABLE_HREF_SCHEME = /^\s*(?:javascript|vbscript|data):/i;

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/iu;
const EMAIL = /^[^\s/@:]+@[^\s/@]+\.[^\s/@]+$/u;

/**
 * A markdown link closes at its first unescaped `)` and its destination is read raw, so characters that would end or
 * reshape it are percent-encoded: the href the editor holds is the one its markdown reads back.
 */
const DESTINATION_UNSAFE = /[\s()<>\\]/gu;

function isExecutable(href: string) {
  return EXECUTABLE_HREF_SCHEME.test(href.replace(/[\u0000-\u001f]/gu, ""));
}

export function toLinkDestination(input: string): string | null {
  const href = normalizeMarkdownHref(input);
  if (!href || isExecutable(href)) return null;
  const withScheme = /^www\./iu.test(href) ? `https://${href}` : EMAIL.test(href) ? `mailto:${href}` : href;
  return withScheme.replace(DESTINATION_UNSAFE, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export type LinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  | { kind: "heading"; slug: string };

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Relative paths resolve beside the document and root-absolute ones from its folder; neither may climb above it. */
export function resolveLinkTarget(href: string, documentPath: string): LinkTarget | null {
  const value = normalizeMarkdownHref(href);
  if (!value || isExecutable(value)) return null;
  if (value.startsWith("#")) return value.length > 1 ? { kind: "heading", slug: decode(value.slice(1)) } : null;
  if (value.startsWith("//")) return { kind: "web", url: `https:${value}` };
  if (URL_SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) return { kind: "web", url: value };
  if (WINDOWS_DRIVE.test(value)) return null;

  const path = value.split(/[?#]/u, 1)[0]!;
  const segments = path.startsWith("/") ? [] : documentPath.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(decode(segment));
  }
  return segments.length ? { kind: "file", path: segments.join("/") } : null;
}

export function headingSlug(text: string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-");
}
