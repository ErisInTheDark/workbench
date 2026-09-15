/* Exports:
 * - default LoaderIcon: continuously spinning loader with non-repeating random motions.
 */
"use client";

import { useEffect, useRef } from "react";
import LoaderAnimationController from "./LoaderAnimationController";
import OutlinedIcon, { type IconProps } from "./OutlinedIcon";

const spokes = ["M12 2v4", "m16.2 7.8 2.9-2.9", "M18 12h4", "m16.2 16.2 2.9 2.9", "M12 18v4", "m4.9 19.1 2.9-2.9", "M2 12h4", "m4.9 4.9 2.9 2.9"];

export default function LoaderIcon(props: IconProps) {
  const group = useRef<SVGGElement>(null);
  useEffect(() => {
    const element = group.current;
    if (!element) return;
    const paths = element.querySelectorAll("path");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let controller: LoaderAnimationController | null = null;
    const update = () => {
      controller?.dispose();
      controller = null;
      if (reducedMotion.matches) return;
      controller = new LoaderAnimationController((target, frames, options) => {
        const node = target === "spin" ? element : paths[target === "traveller" ? 8 : target]!;
        return node.animate(frames, options);
      });
      controller.start();
    };
    update();
    reducedMotion.addEventListener("change", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      controller?.dispose();
    };
  }, []);

  return <OutlinedIcon {...props} viewportPadding={2}>
    <g ref={group} style={{ transformBox: "view-box", transformOrigin: "50% 50%" }}>
      {spokes.map(path => <path key={path} d={path} />)}
      <path d={spokes[0]} style={{ opacity: 0, transformBox: "view-box", transformOrigin: "50% 50%" }} />
    </g>
  </OutlinedIcon>;
}
