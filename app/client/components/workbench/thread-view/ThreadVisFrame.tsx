/*
 * Exports:
 * - default ThreadVisFrame: load an agent-authored page from the vis origin in a sandboxed frame: it runs its scripts and
 *   reaches its own origin (storage, its project's files) but never the app's or the internet; a standalone document
 *   (such as a code block preview) runs opaque with no network instead. Its `window.wb` bridge
 *   starts from the file's stored control state, painted in the app's theme; the frame takes the height its page reports,
 *   follows control state set elsewhere, and forwards its own control changes to `onControl` only while focused.
 *   Fullscreen lifts it over the whole page, with a close button, without reloading its page.
 */
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VisControls } from "workbench-shared/workbench/vis/vis-contract";
import {
  acceptVisFrameControl, frameVisDocument, readVisFrameHeight, VIS_FRAME_SANDBOX, VIS_STANDALONE_SANDBOX,
  visFrameControlsMessage, visFrameThemeMessage,
} from "workbench-shared/workbench/vis/vis-frame";
import { VIS_THEME_PARAM } from "workbench-shared/workbench/vis/vis-url";
import useDocumentTheme from "../../../workbench/app/use-document-theme";
import IconButton from "../../ui/IconButton";
import { XIcon } from "../workbench-icons";

const NO_CONTROLS: VisControls = {};

/**
 * Served pages receive messages only on the vis origin, so one that navigated elsewhere never learns the file's state;
 * standalone pages have an opaque origin, which only `*` reaches.
 */
function postToFrame(frame: HTMLIFrameElement | null, message: object, origin: string) {
  frame?.contentWindow?.postMessage(message, origin);
}

const fullscreenClassName = `
  fixed inset-0 m-0 size-full max-h-none max-w-none overflow-y-auto border-0 p-4 md:p-6
  bg-canvas text-text scrollbar-hover-reveal backdrop:bg-transparent
`;

/**
 * A page served from the vis origin (a new URL loads a new render), or a standalone document with no origin to load
 * from, such as a code block's preview.
 */
type ThreadVisFramePage = { src: string } | { document: string };

/** `className` styles the frame's box; its height follows the page's content. */
export default function ThreadVisFrame({
  className = "", controls = NO_CONTROLS, fullscreen = false, onControl, onExitFullscreen, page, title,
}: {
  className?: string;
  /** The file's stored control state; snapshots show their page without it. */
  controls?: VisControls;
  page: ThreadVisFramePage;
  /** Covers the whole page; the frame keeps its content height and the cover scrolls. */
  fullscreen?: boolean;
  /** Live frames only; snapshots ignore what their page sets. */
  onControl?: (id: string, value: string) => void;
  /** The cover's close button and Escape (while focus is outside the frame) call this. */
  onExitFullscreen?: () => void;
  title: string;
}) {
  const coverRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const onExitFullscreenRef = useRef(onExitFullscreen);
  onExitFullscreenRef.current = onExitFullscreen;
  // The top layer escapes the transforms and clipping of whatever holds the frame, and unlike a portal it never
  // moves the frame in the DOM, which would reload its page.
  useLayoutEffect(() => {
    const cover = coverRef.current;
    if (!fullscreen || !cover) return;
    cover.showPopover();
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExitFullscreenRef.current?.();
    };
    window.addEventListener("keydown", exit);
    return () => {
      window.removeEventListener("keydown", exit);
      if (cover.matches(":popover-open")) cover.hidePopover();
    };
  }, [fullscreen]);
  // Changes this frame made that the stored state has not echoed yet; they win, so a late echo never undoes a newer pick.
  const pendingRef = useRef(new Map<string, string>());
  for (const [id, value] of pendingRef.current) if (controls[id] === value) pendingRef.current.delete(id);
  const current = { ...controls, ...Object.fromEntries(pendingRef.current) };
  const currentRef = useRef(current);
  currentRef.current = current;
  const theme = useDocumentTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // State and palette are seeded once per page; later changes reach the running page as messages, so they never reload it.
  const pageKey = "src" in page ? `src:${page.src}` : `document:${page.document}`;
  const source = useMemo(() => {
    if ("document" in page) {
      return {
        src: undefined, srcDoc: frameVisDocument(page.document, currentRef.current, { theme: themeRef.current }),
        sandbox: VIS_STANDALONE_SANDBOX, origin: "*",
      };
    }
    const url = new URL(page.src);
    url.searchParams.set(VIS_THEME_PARAM, themeRef.current);
    return { src: url.href, srcDoc: undefined, sandbox: VIS_FRAME_SANDBOX, origin: url.origin };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pageKey` is the page's meaning; its identity is noise.
  }, [pageKey]);
  const originRef = useRef(source.origin);
  originRef.current = source.origin;
  useEffect(() => {
    postToFrame(frameRef.current, visFrameThemeMessage(theme), originRef.current);
  }, [theme]);
  /** Null until the page first reports its height. */
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    postToFrame(frameRef.current, visFrameControlsMessage(currentRef.current), originRef.current);
  }, [controls]);
  /** The page starts from the state stored when it was served; this catches it up on anything since, and the theme. */
  const onLoad = () => {
    postToFrame(frameRef.current, visFrameControlsMessage(currentRef.current), originRef.current);
    postToFrame(frameRef.current, visFrameThemeMessage(themeRef.current), originRef.current);
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      const fromOwnFrame = Boolean(frame) && event.source === frame!.contentWindow;
      const reported = readVisFrameHeight({ fromOwnFrame, data: event.data });
      if (reported !== null) {
        setHeight(reported);
        return;
      }
      if (!onControlRef.current) return;
      const change = acceptVisFrameControl({ fromOwnFrame, frameFocused: Boolean(frame) && frame!.ownerDocument.activeElement === frame, data: event.data });
      if (!change) return;
      pendingRef.current.set(change.id, change.value);
      onControlRef.current(change.id, change.value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className={fullscreen ? fullscreenClassName : "contents"} popover={fullscreen ? "manual" : undefined} ref={coverRef}>
      <div className={`overflow-hidden ${height === null ? "h-48" : ""} ${className}`} style={height === null ? undefined : { height }}>
        <iframe
          className="block size-full border-0 bg-transparent scheme-light-dark"
          onLoad={onLoad}
          ref={frameRef}
          sandbox={source.sandbox}
          src={source.src}
          srcDoc={source.srcDoc}
          title={title}
        />
      </div>
      {fullscreen ? (
        <IconButton className="fixed right-3 top-3" label="Exit fullscreen" onClick={onExitFullscreen}>
          <XIcon size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}
