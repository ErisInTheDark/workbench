/*
 * Exports:
 * - default ThreadVisFrame: render an agent-authored document in a sandboxed frame that runs its scripts but reaches no network.
 */
"use client";

// Inline scripts and styles run; nothing loads from anywhere, though embedded data: images and fonts still work.
const CONTENT_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

/** The policy must come before anything the document loads, but after a doctype, which must stay first. */
function withContentPolicy(document: string) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(document);
  return doctype ? `${doctype[0]}${CONTENT_POLICY}${document.slice(doctype[0].length)}` : `${CONTENT_POLICY}${document}`;
}

/** `className` sizes the frame's box; vis boxes are resizable by dragging their bottom edge. */
export default function ThreadVisFrame({ className = "", document, resizable = false, title }: {
  className?: string;
  document: string;
  resizable?: boolean;
  title: string;
}) {
  return (
    <div className={`${resizable ? "resize-y overflow-hidden" : ""} ${className}`}>
      <iframe
        className="block size-full border-0 bg-transparent scheme-light-dark"
        sandbox="allow-scripts"
        srcDoc={withContentPolicy(document)}
        title={title}
      />
    </div>
  );
}
