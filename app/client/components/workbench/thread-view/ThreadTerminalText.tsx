/* Exports: default ThreadTerminalText caps wrapped previews at three visual lines with one-way expansion. */
"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import ThreadAnsiOutput from "./ThreadAnsiOutput";

export default function ThreadTerminalText({ text, expanded, onExpand, command = false, failed = false }: {
  text: string;
  expanded: boolean;
  onExpand: () => void;
  command?: boolean;
  failed?: boolean;
}) {
  const preview = useRef<HTMLPreElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const shown = useMemo(() => {
    if (expanded) return text;
    let end = -1;
    for (let line = 0; line < 3; line++) {
      end = text.indexOf("\n", end + 1);
      if (end < 0) return text;
    }
    return text.slice(0, end);
  }, [text, expanded]);
  const content = useMemo(() => <ThreadAnsiOutput output={shown} />, [shown]);
  useLayoutEffect(() => {
    const node = preview.current;
    if (!node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, expanded, command]);

  return <div className={`relative font-mono text-[0.78em] leading-[1.6] ${failed ? "text-danger" : command ? "text-text" : "text-fg/muted"}`}>
    <pre ref={preview} className={`m-0 whitespace-pre-wrap [overflow-wrap:anywhere] font-[inherit] leading-[inherit] ${expanded ? "" : "max-h-[3lh] overflow-hidden pr-[5ch]"}`}>
      {command ? "> " : null}{content}
    </pre>
    {!expanded && (shown.length < text.length || overflowing) ? <button
      type="button"
      className="absolute bottom-0 right-0 cursor-pointer rounded px-1 [&:hover]:bg-fg-alpha/7 focus-visible:outline focus-visible:outline-1"
      aria-label={command ? "Show full command" : "Show full output"}
      onClick={onExpand}
    >[...]</button> : null}
  </div>;
}
