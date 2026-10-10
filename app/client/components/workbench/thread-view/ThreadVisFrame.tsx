/*
 * Exports:
 * - default ThreadVisFrame: render an agent-authored document in a sandboxed frame that runs its scripts but reaches no network,
 *   with the injected `window.wb` bridge; the frame takes the height its page reports, and answers reach `onAnswer` only
 *   from this frame while it has focus.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { acceptVisFrameAnswer, frameVisDocument, readVisFrameHeight } from "workbench-shared/workbench/vis/vis-frame";

/** `className` styles the frame's box; its height follows the page's content. */
export default function ThreadVisFrame({ className = "", document, onAnswer, title }: {
  className?: string;
  document: string;
  /** Live frames only; snapshots ignore what their page sends. */
  onAnswer?: (value: string) => void;
  title: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  /** Null until the page first reports its height. */
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      const fromOwnFrame = Boolean(frame) && event.source === frame!.contentWindow;
      const reported = readVisFrameHeight({ fromOwnFrame, data: event.data });
      if (reported !== null) {
        setHeight(reported);
        return;
      }
      if (!onAnswerRef.current) return;
      const value = acceptVisFrameAnswer({ fromOwnFrame, frameFocused: Boolean(frame) && frame!.ownerDocument.activeElement === frame, data: event.data });
      if (value !== null) onAnswerRef.current(value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className={`overflow-hidden ${height === null ? "h-48" : ""} ${className}`} style={height === null ? undefined : { height }}>
      <iframe
        className="block size-full border-0 bg-transparent scheme-light-dark"
        ref={frameRef}
        sandbox="allow-scripts"
        srcDoc={frameVisDocument(document)}
        title={title}
      />
    </div>
  );
}
