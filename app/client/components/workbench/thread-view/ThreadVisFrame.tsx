/*
 * Exports:
 * - default ThreadVisFrame: render an agent-authored document in a sandboxed frame that runs its scripts but reaches no network,
 *   with the injected `window.wb` bridge; answers reach `onAnswer` only from this frame while it has focus.
 */
"use client";

import { useEffect, useRef } from "react";
import { acceptVisFrameAnswer, VIS_BRIDGE_SCRIPT } from "./vis-frame-messages";

// Inline scripts and styles run; nothing loads from anywhere, though embedded data: images and fonts still work.
const CONTENT_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

/** The policy and bridge must come before anything the document runs, but after a doctype, which must stay first. */
function withFrameHead(document: string) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(document);
  const head = `${CONTENT_POLICY}${VIS_BRIDGE_SCRIPT}`;
  return doctype ? `${doctype[0]}${head}${document.slice(doctype[0].length)}` : `${head}${document}`;
}

/** `className` sizes the frame's box; vis boxes are resizable by dragging their bottom edge. */
export default function ThreadVisFrame({ className = "", document, onAnswer, resizable = false, title }: {
  className?: string;
  document: string;
  /** Live frames only; snapshots ignore what their page sends. */
  onAnswer?: (value: string) => void;
  resizable?: boolean;
  title: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const listens = Boolean(onAnswer);
  useEffect(() => {
    if (!listens) return;
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      const value = acceptVisFrameAnswer({
        fromOwnFrame: Boolean(frame) && event.source === frame!.contentWindow,
        frameFocused: Boolean(frame) && frame!.ownerDocument.activeElement === frame,
        data: event.data,
      });
      if (value !== null) onAnswerRef.current?.(value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [listens]);
  return (
    <div className={`${resizable ? "resize-y overflow-hidden" : ""} ${className}`}>
      <iframe
        className="block size-full border-0 bg-transparent scheme-light-dark"
        ref={frameRef}
        sandbox="allow-scripts"
        srcDoc={withFrameHead(document)}
        title={title}
      />
    </div>
  );
}
